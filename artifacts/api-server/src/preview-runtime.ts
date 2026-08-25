import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { Request, Response } from "express";
import { getRegisteredProposal, isProposalPreviewable } from "./repository/patch-executor";

export type PreviewState = "starting" | "running" | "reloading" | "stopped" | "build_error" | "runtime_error";
export type PreviewStatus = {
  proposalId: string;
  state: PreviewState;
  url: string;
  command: string;
  output: string;
  startedAt?: string;
  updatedAt: string;
};

type PreviewProcess = PreviewStatus & { process?: ChildProcessWithoutNullStreams; port: number };
const previews = new Map<string, PreviewProcess>();
const PREVIEW_PORT = 24991;
const MAX_OUTPUT = 12_000;
const previewCommand = ["--filter", "@workspace/cosmic-agent", "run", "dev"];

function now() { return new Date().toISOString(); }
function publicStatus(item: PreviewProcess): PreviewStatus {
  const { process: _process, port: _port, ...status } = item;
  return status;
}
function append(item: PreviewProcess, value: string) {
  item.output = `${item.output}\n${value}`.trim().slice(-MAX_OUTPUT);
  item.updatedAt = now();
}
function eligible(proposalId: string) {
  const registered = getRegisteredProposal(proposalId);
  if (!registered) throw new Error("Preview requires a known proposal.");
  if (!isProposalPreviewable(proposalId)) throw new Error("Preview is available only after explicit approval and successful validation.");
  return registered;
}
async function waitForPort(port: number, timeoutMs = 18_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ hostname: "127.0.0.1", port, path: "/" }, (response) => {
          response.resume();
          response.once("end", resolve);
        });
        request.once("error", reject);
        request.setTimeout(900, () => { request.destroy(); reject(new Error("timeout")); });
      });
      return true;
    } catch { await new Promise((resolve) => setTimeout(resolve, 180)); }
  }
  return false;
}

export async function startPreview(proposalId: string): Promise<PreviewStatus> {
  eligible(proposalId);
  const existing = previews.get(proposalId);
  if (existing?.process && !existing.process.killed) {
    existing.state = "reloading";
    existing.updatedAt = now();
    existing.process.kill("SIGTERM");
  }
  const item: PreviewProcess = {
    proposalId, state: "starting", url: `/api/preview/${encodeURIComponent(proposalId)}/`,
    command: `pnpm ${previewCommand.join(" ")}`, output: "", port: PREVIEW_PORT, updatedAt: now(), startedAt: now(),
  };
  previews.set(proposalId, item);
  // Deliberately construct this command from constants. No request input is
  // accepted as an executable, argument, cwd, or environment variable.
  const child = spawn("pnpm", previewCommand, {
    cwd: process.cwd(),
    shell: false,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "development",
      CI: "1",
      PORT: String(PREVIEW_PORT),
      BASE_PATH: `/api/preview/${encodeURIComponent(proposalId)}/`,
    },
  });
  item.process = child;
  child.stdout.on("data", (chunk: Buffer) => append(item, chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => append(item, chunk.toString()));
  child.once("error", (error) => { item.state = "runtime_error"; append(item, error.message); });
  child.once("exit", (code) => {
    if (item.state !== "running" && item.state !== "starting" && item.state !== "reloading") return;
    item.state = code === 0 ? "stopped" : "runtime_error";
    append(item, `Preview process exited with code ${code ?? "unknown"}.`);
  });
  const ready = await waitForPort(PREVIEW_PORT);
  if (ready && child.exitCode === null) {
    item.state = "running"; item.updatedAt = now();
  } else if (item.state === "starting" || item.state === "reloading") {
    item.state = "build_error"; append(item, "The approved application did not start within the safe startup window.");
  }
  return publicStatus(item);
}

export function getPreview(proposalId: string): PreviewStatus {
  eligible(proposalId);
  const item = previews.get(proposalId);
  if (!item) return { proposalId, state: "stopped", url: `/api/preview/${encodeURIComponent(proposalId)}/`, command: `pnpm ${previewCommand.join(" ")}`, output: "", updatedAt: now() };
  return publicStatus(item);
}
export async function stopPreview(proposalId: string): Promise<PreviewStatus> {
  eligible(proposalId);
  const item = previews.get(proposalId);
  if (item?.process && !item.process.killed) item.process.kill("SIGTERM");
  if (item) { item.state = "stopped"; item.updatedAt = now(); return publicStatus(item); }
  return getPreview(proposalId);
}
export async function proxyPreview(req: Request, res: Response, proposalId: string): Promise<void> {
  const item = previews.get(proposalId);
  if (!item || item.state !== "running") { res.status(409).json({ error: "Preview is not running." }); return; }
  const requestPath = req.originalUrl.replace(`/api/preview/${encodeURIComponent(proposalId)}`, "") || "/";
  const proxy = http.request({ hostname: "127.0.0.1", port: item.port, path: requestPath, method: req.method, headers: { accept: req.headers.accept ?? "*/*" } }, (upstream) => {
    res.status(upstream.statusCode ?? 502);
    for (const [key, value] of Object.entries(upstream.headers)) if (value && !["set-cookie", "connection", "transfer-encoding"].includes(key)) res.setHeader(key, value);
    upstream.pipe(res);
  });
  proxy.once("error", () => { if (!res.headersSent) res.status(502).json({ error: "Preview runtime became unavailable." }); else res.end(); });
  proxy.end();
}