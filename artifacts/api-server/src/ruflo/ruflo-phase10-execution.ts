import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TERMINAL_OUTPUT = 24_000;
const MAX_BROWSER_TEXT = 24_000;

type TerminalRecord = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

const terminalHistory = new Map<string, TerminalRecord[]>();
const browserPages = new Map<string, SafeBrowserPage>();

export type SafeBrowserPage = {
  sessionId: string;
  url: string;
  title: string;
  text: string;
  status: number;
  contentType: string;
  fetchedAt: string;
};

export function listSandboxedTerminals(userId: string): TerminalRecord[] {
  return (terminalHistory.get(userId) ?? []).slice(-24).map((entry) => ({ ...entry, args: [...entry.args] }));
}

export function createSandboxedTerminal(userId: string): { terminalId: string; status: "ready"; allowedCommands: string[] } {
  const terminalId = `term-${cryptoRandomId()}`;
  const records = terminalHistory.get(userId) ?? [];
  records.push({
    id: terminalId,
    command: "created",
    args: [],
    cwd: "",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  terminalHistory.set(userId, records.slice(-24));
  return { terminalId, status: "ready", allowedCommands: ["pwd", "ls", "rg", "git", "pnpm"] };
}

export function closeSandboxedTerminal(userId: string, terminalId?: string): { closed: boolean; terminalId?: string } {
  const records = terminalHistory.get(userId) ?? [];
  const record = terminalId ? records.find((entry) => entry.id === terminalId) : records.at(-1);
  return { closed: Boolean(record), terminalId: record?.id };
}

export async function runSandboxedTerminal(input: {
  userId: string;
  command: unknown;
  args?: unknown;
  cwd: string;
  timeoutMs?: number;
}): Promise<TerminalRecord> {
  const command = input.command;
  if (typeof command !== "string" || !["pwd", "ls", "rg", "git", "pnpm"].includes(command)) {
    throw new Error("Only the fixed Ruflo terminal command allowlist is available.");
  }
  const args = normalizeArguments(input.args);
  validateTerminalArguments(command, args);
  const startedAt = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await execFileAsync(command, args, {
      cwd: input.cwd,
      shell: false,
      timeout: Math.max(250, Math.min(30_000, input.timeoutMs ?? 15_000)),
      maxBuffer: MAX_TERMINAL_OUTPUT * 2,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: input.cwd,
        CI: "1",
        NO_COLOR: "1",
      },
    });
    stdout = String(result.stdout).slice(0, MAX_TERMINAL_OUTPUT);
    stderr = String(result.stderr).slice(0, MAX_TERMINAL_OUTPUT);
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    exitCode = typeof failed.code === "number" ? failed.code : 1;
    stdout = typeof failed.stdout === "string" ? failed.stdout.slice(0, MAX_TERMINAL_OUTPUT) : "";
    stderr = typeof failed.stderr === "string" ? failed.stderr.slice(0, MAX_TERMINAL_OUTPUT) : String(error).slice(0, MAX_TERMINAL_OUTPUT);
  }
  const record: TerminalRecord = {
    id: `run-${cryptoRandomId()}`,
    command,
    args,
    cwd: input.cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    stdout,
    stderr,
  };
  const history = terminalHistory.get(input.userId) ?? [];
  history.push(record);
  terminalHistory.set(input.userId, history.slice(-24));
  return { ...record, args: [...record.args] };
}

export function listSafeBrowserSessions(): SafeBrowserPage[] {
  return [...browserPages.values()].map((page) => ({ ...page }));
}

export async function openSafeBrowserPage(sessionId: string, rawUrl: string): Promise<SafeBrowserPage> {
  const url = await validatePublicHttpsUrl(rawUrl);
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
    headers: { accept: "text/html,text/plain;q=0.9,application/xhtml+xml;q=0.8" },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Redirects are blocked; validate and open the final public HTTPS URL explicitly.");
  }
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  if (!/^text\/(plain|html)|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error("Only public text or HTML pages are available through browser-lite.");
  }
  const body = (await response.text()).slice(0, 80_000);
  const text = stripHtml(body).slice(0, MAX_BROWSER_TEXT);
  const page: SafeBrowserPage = {
    sessionId: sessionId.slice(0, 120),
    url: response.url || url,
    title: extractTitle(body).slice(0, 300),
    text,
    status: response.status,
    contentType: contentType.slice(0, 120),
    fetchedAt: new Date().toISOString(),
  };
  browserPages.set(page.sessionId, page);
  return { ...page };
}

export function getSafeBrowserPage(sessionId: string): SafeBrowserPage {
  const page = browserPages.get(sessionId);
  if (!page) throw new Error("Browser session was not found.");
  return { ...page };
}

export function closeSafeBrowserPage(sessionId: string): { closed: boolean; sessionId: string } {
  const closed = browserPages.delete(sessionId);
  return { closed, sessionId };
}

async function validatePublicHttpsUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Browser-lite requires a valid public HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port && !["443", ""].includes(url.port)) {
    throw new Error("Browser-lite permits only credential-free public HTTPS URLs on port 443.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Private and local hostnames are blocked.");
  }
  const addresses = isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("Private, loopback, link-local, and reserved network addresses are blocked.");
  return url.toString();
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}

function normalizeArguments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 200));
}

function validateTerminalArguments(command: string, args: string[]): void {
  if (args.some((arg) => arg.includes("\u0000") || arg.length > 200)) throw new Error("Terminal arguments contain an unsafe value.");
  if (command === "pwd" && args.length) throw new Error("pwd does not accept arguments.");
  if (command === "ls" && args.some((arg) => !["-la", "-l", "-a"].includes(arg))) throw new Error("ls is limited to safe listing flags.");
  if (command === "rg" && (args.length > 8 || args.some((arg) => arg.startsWith("-g") && arg.includes("..")))) throw new Error("rg arguments exceed the bounded search policy.");
  if (command === "git" && !(args.length <= 2 && (args[0] === "status" || args[0] === "diff" || args[0] === "log"))) throw new Error("git is limited to read-only status, diff, and log commands.");
  if (command === "pnpm" && !(args.join(" ") === "--version" || args.join(" ") === "run typecheck" || args.join(" ") === "run build")) throw new Error("pnpm is limited to version, typecheck, and build validation.");
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[redacted]");
}

function extractTitle(value: string): string {
  return value.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

function cryptoRandomId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}