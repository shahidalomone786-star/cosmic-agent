import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { Request, Response } from "express";
import { getRegisteredProposal, isProposalPreviewable } from "./repository/patch-executor";
import { recordPreviewLifecycle } from "./ai/agent-runtime";
import { recordLocalLifecycle } from "./workspace/local-session";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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

type PreviewProcess = PreviewStatus & { process?: ChildProcessWithoutNullStreams; port: number; workspaceRoot: string; entryFile?: string };
type PreviewTarget = { root: string; entryFile?: string; usesDevServer: boolean };
const previews = new Map<string, PreviewProcess>();
const MAX_OUTPUT = 12_000;
const previewCommand = ["exec", "vite", "--host", "127.0.0.1"];

function now() { return new Date().toISOString(); }
function publicStatus(item: PreviewProcess): PreviewStatus {
  const { process: _process, port: _port, ...status } = item;
  return status;
}
function append(item: PreviewProcess, value: string) {
  item.output = `${item.output}\n${value}`.trim().slice(-MAX_OUTPUT);
  item.updatedAt = now();
}
function eligible(proposalId: string, ownerId?: string) {
  const registered = getRegisteredProposal(proposalId);
  if (!registered) throw new Error("Preview requires a known proposal.");
  if (registered.ownerId && registered.ownerId !== ownerId) throw new Error("Preview access is limited to the owning user.");
  if (!isProposalPreviewable(proposalId)) throw new Error("Preview is available only after explicit approval and successful validation.");
  return registered;
}
function previewUrl(proposalId: string) {
  return `/api/preview/${encodeURIComponent(proposalId)}/`;
}
function lifecycle(proposalId: string, phase: "preview_starting" | "preview_ready" | "preview_failed", detail: string) {
  recordPreviewLifecycle(proposalId, phase, detail);
  recordLocalLifecycle(proposalId, phase, detail);
}
async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}
async function resolvePreviewTarget(registered: NonNullable<ReturnType<typeof getRegisteredProposal>>): Promise<PreviewTarget> {
  if (registered.workspaceRoot) {
    if (await exists(path.join(registered.workspaceRoot, "package.json"))) return { root: registered.workspaceRoot, usesDevServer: true };
    return { root: registered.workspaceRoot, usesDevServer: false };
  }
  const files = registered.proposal.files.map((file) => file.path.replaceAll("\\", "/"));
  const html = files.find((file) => file.toLowerCase().endsWith(".html"));
  if (html && !html.endsWith("/index.html") && !html.endsWith("index.html")) {
    return { root: path.resolve(process.cwd(), path.dirname(html)), entryFile: path.basename(html), usesDevServer: false };
  }
  const packageFile = files.find((file) => path.posix.basename(file) === "package.json");
  if (packageFile) return { root: path.resolve(process.cwd(), path.dirname(packageFile)), usesDevServer: true };
  if (html) return { root: path.resolve(process.cwd(), path.dirname(html)), usesDevServer: false };
  return { root: process.cwd(), usesDevServer: false };
}
function previewPort(proposalId: string): number {
  return 25000 + (parseInt(createHash("sha256").update(proposalId).digest("hex").slice(0, 4), 16) % 900);
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
async function installProjectDependencies(root: string): Promise<{ ok: boolean; output: string }> {
  const child = spawn("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile", "--prefer-offline"], {
    cwd: root,
    shell: false,
    stdio: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "development", CI: "1" },
  });
  let output = "";
  const appendOutput = (chunk: Buffer) => {
    output = `${output}\n${chunk.toString()}`.trim().slice(-MAX_OUTPUT);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ ok: false, output: `${output}\n${error.message}`.trim().slice(-MAX_OUTPUT) }));
    child.once("exit", (code) => resolve({ ok: code === 0, output }));
  });
}

export async function startPreview(proposalId: string, ownerId?: string): Promise<PreviewStatus> {
  const registered = eligible(proposalId, ownerId);
  const existing = previews.get(proposalId);
  if (existing?.process && !existing.process.killed) {
    existing.state = "reloading";
    existing.updatedAt = now();
    existing.process.kill("SIGTERM");
  }
  const target = await resolvePreviewTarget(registered);
  const port = target.usesDevServer ? previewPort(proposalId) : 0;
  const item: PreviewProcess = {
    proposalId, state: "starting", url: previewUrl(proposalId),
    command: target.usesDevServer ? "pnpm exec vite --host 127.0.0.1 --port <server-selected>" : "server-controlled static project preview",
    output: "", port, workspaceRoot: target.root, entryFile: target.entryFile, updatedAt: now(), startedAt: now(),
  };
  previews.set(proposalId, item);
  lifecycle(proposalId, "preview_starting", "The server selected the approved project entry point.");
  if (!target.usesDevServer) {
    const entry = path.join(target.root, target.entryFile ?? "index.html");
    if (!(await exists(entry))) {
      item.state = "build_error";
      append(item, "No supported project entry point was found. Add index.html, an HTML entry point, or package.json.");
      lifecycle(proposalId, "preview_failed", item.output);
      return publicStatus(item);
    }
    item.state = "running";
    lifecycle(proposalId, "preview_ready", "The approved project is ready in the Preview viewport.");
    return publicStatus(item);
  }
  const dependencies = await installProjectDependencies(target.root);
  if (!dependencies.ok) {
    item.state = "build_error";
    append(item, `Project dependency installation failed.${dependencies.output ? `\n${dependencies.output}` : ""}`);
    lifecycle(proposalId, "preview_failed", item.output);
    return publicStatus(item);
  }
  // Deliberately construct this command from constants. No request input is
  // accepted as an executable, argument, cwd, or environment variable.
  const child = spawn("pnpm", [...previewCommand, "--port", String(port)], {
    cwd: target.root,
    shell: false,
    stdio: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "development", CI: "1" },
  });
  item.process = child;
  child.stdout.on("data", (chunk: Buffer) => append(item, chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => append(item, chunk.toString()));
  child.once("error", (error) => { item.state = "runtime_error"; append(item, error.message); lifecycle(proposalId, "preview_failed", error.message); });
  child.once("exit", (code) => {
    if (item.state !== "running" && item.state !== "starting" && item.state !== "reloading") return;
    item.state = code === 0 ? "stopped" : "runtime_error";
    append(item, `Preview process exited with code ${code ?? "unknown"}.`);
    if (item.state === "runtime_error") lifecycle(proposalId, "preview_failed", item.output);
  });
  const ready = await waitForPort(port);
  if (ready && child.exitCode === null) {
    item.state = "running"; item.updatedAt = now();
    lifecycle(proposalId, "preview_ready", "The approved project runtime is ready in the Preview viewport.");
  } else if (item.state === "starting" || item.state === "reloading") {
    item.state = "build_error"; append(item, "The approved project did not start within the safe startup window."); lifecycle(proposalId, "preview_failed", item.output); child.kill("SIGTERM");
  }
  return publicStatus(item);
}

export function getPreview(proposalId: string, ownerId?: string): PreviewStatus {
  const registered = eligible(proposalId, ownerId);
  const item = previews.get(proposalId);
  if (!item) return { proposalId, state: "stopped", url: previewUrl(proposalId), command: "server-controlled approved project preview", output: "", updatedAt: now() };
  return publicStatus(item);
}
export async function stopPreview(proposalId: string, ownerId?: string): Promise<PreviewStatus> {
  eligible(proposalId, ownerId);
  const item = previews.get(proposalId);
  if (item?.process && !item.process.killed) item.process.kill("SIGTERM");
  if (item) { item.state = "stopped"; item.updatedAt = now(); return publicStatus(item); }
  return getPreview(proposalId);
}
export async function proxyPreview(req: Request, res: Response, proposalId: string, ownerId?: string): Promise<void> {
  const registered = getRegisteredProposal(proposalId);
  if (!registered || (registered.ownerId && registered.ownerId !== ownerId)) { res.status(404).json({ error: "Preview not found." }); return; }
  const item = previews.get(proposalId);
  if (!item || item.state !== "running") { res.status(409).json({ error: "Preview is not running." }); return; }
  if (item.port === 0) {
    const requestPath = req.originalUrl.replace(`/api/preview/${encodeURIComponent(proposalId)}`, "").split("?")[0] || "/";
    const relative = requestPath === "/" ? item.entryFile ?? "index.html" : requestPath.replace(/^\/+/, "");
    try {
      const safe = path.resolve(item.workspaceRoot, relative);
      if (!safe.startsWith(path.resolve(item.workspaceRoot) + path.sep)) throw new Error("Unsafe preview path.");
      const content = await fs.readFile(safe);
      const type = safe.endsWith(".html") ? "text/html; charset=utf-8" : safe.endsWith(".css") ? "text/css; charset=utf-8" : safe.endsWith(".js") ? "text/javascript; charset=utf-8" : safe.endsWith(".json") ? "application/json; charset=utf-8" : safe.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      res.setHeader("Cache-Control", "no-store");
      res.type(type).send(content);
    } catch {
      res.status(404).json({ error: "Preview file not found." });
    }
    return;
  }
  const requestPath = req.originalUrl.replace(`/api/preview/${encodeURIComponent(proposalId)}`, "") || "/";
  const proxy = http.request({ hostname: "127.0.0.1", port: item.port, path: requestPath, method: req.method, headers: { accept: req.headers.accept ?? "*/*" } }, (upstream) => {
    res.status(upstream.statusCode ?? 502);
    for (const [key, value] of Object.entries(upstream.headers)) if (value && !["set-cookie", "connection", "transfer-encoding"].includes(key)) res.setHeader(key, value);
    upstream.pipe(res);
  });
  proxy.once("error", () => { if (!res.headersSent) res.status(502).json({ error: "Preview runtime became unavailable." }); else res.end(); });
  proxy.end();
}