import { logger } from "../lib/logger";

export type RepositoryRef = {
  id: string;
  owner: string;
  name: string;
  branch: string;
  defaultBranch: string;
  webUrl: string;
};

export type TreeEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  language?: string;
};

export type FileResult = {
  path: string;
  language: string;
  size: number;
  content: string;
  truncated: boolean;
};

const GITHUB_API = "https://api.github.com";
const MAX_FILE_BYTES = 180_000;
const BLOCKED = /(^|\/)(node_modules|dist|build|\.git|\.cache|coverage)(\/|$)/i;
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|crt))$/i;

export class RepositoryError extends Error {
  constructor(readonly code: "not_connected" | "not_found" | "permission_denied" | "rate_limited" | "unsupported_binary" | "too_large" | "network", message: string) {
    super(message);
  }
}

export function parseGitHubUrl(value: string): { owner: string; name: string } {
  const normalized = value.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) throw new RepositoryError("not_found", "Enter a valid GitHub repository URL, such as https://github.com/owner/repository.");
  return { owner: match[1], name: match[2] };
}

async function githubFetch<T>(path: string): Promise<T> {
  try {
    const response = await fetch(`${GITHUB_API}${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Cosmic-Agent-Read-Only" } });
    if (response.status === 403) throw new RepositoryError("rate_limited", "GitHub is rate limiting public requests. Connect GitHub for higher-limit repository access.");
    if (response.status === 404) throw new RepositoryError("not_found", "GitHub could not find that repository or file.");
    if (response.status === 401) throw new RepositoryError("permission_denied", "This repository requires GitHub authorization. Connect GitHub to access private repositories.");
    if (!response.ok) throw new RepositoryError("network", "GitHub is temporarily unavailable.");
    return await response.json() as T;
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    logger.warn({ err: error }, "GitHub read request failed");
    throw new RepositoryError("network", "Could not reach GitHub. Check the repository URL and try again.");
  }
}

export async function connectRepository(url: string, branch?: string): Promise<RepositoryRef> {
  const { owner, name } = parseGitHubUrl(url);
  const repo = await githubFetch<{ id: number; html_url: string; default_branch: string; full_name: string }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  return { id: String(repo.id), owner, name, branch: branch?.trim() || repo.default_branch, defaultBranch: repo.default_branch, webUrl: repo.html_url };
}

export async function listTree(repository: RepositoryRef, path = ""): Promise<TreeEntry[]> {
  if (BLOCKED.test(path) || SECRET_FILE.test(path)) return [];
  const ref = encodeURIComponent(repository.branch);
  const encodedPath = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  const data = await githubFetch<Array<{ path: string; name: string; type: string; size?: number }>>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents${encodedPath}?ref=${ref}`);
  return data.filter((entry) => !BLOCKED.test(entry.path) && !SECRET_FILE.test(entry.path)).map((entry) => ({ path: entry.path, name: entry.name, type: entry.type === "dir" ? ("directory" as const) : ("file" as const), size: entry.size, language: languageFor(entry.name) })).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
}

export async function readRepositoryFile(repository: RepositoryRef, path: string): Promise<FileResult> {
  if (BLOCKED.test(path) || SECRET_FILE.test(path)) throw new RepositoryError("permission_denied", "This file is protected from repository context.");
  const data = await githubFetch<{ content?: string; encoding?: string; size?: number; type?: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(repository.branch)}`);
  if (data.type !== "file") throw new RepositoryError("not_found", "That path is not a readable file.");
  if ((data.size ?? 0) > MAX_FILE_BYTES) throw new RepositoryError("too_large", "This file is larger than the safe context limit. Search for a symbol instead.");
  if (!data.content || data.encoding !== "base64") throw new RepositoryError("unsupported_binary", "This file is not a supported text file.");
  const decoded = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { path, language: languageFor(path), size: data.size ?? decoded.length, content: redactSecrets(decoded).slice(0, MAX_FILE_BYTES), truncated: decoded.length > MAX_FILE_BYTES };
}

export async function searchRepository(repository: RepositoryRef, query: string): Promise<Array<{ path: string; line: number; context: string }>> {
  const safeQuery = query.trim();
  if (!safeQuery) return [];
  const treeResponse = await githubFetch<{ tree?: Array<{ path: string; type: string }> }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${encodeURIComponent(repository.branch)}?recursive=1`);
  const candidates = (treeResponse.tree ?? []).filter((entry) => entry.type === "blob" && !BLOCKED.test(entry.path) && !SECRET_FILE.test(entry.path)).slice(0, 500);
  const results: Array<{ path: string; line: number; context: string }> = [];
  for (const entry of candidates) {
    if (results.length >= 40) break;
    if (entry.path.toLowerCase().includes(safeQuery.toLowerCase())) { results.push({ path: entry.path, line: 1, context: "Filename match" }); continue; }
    try {
      const file = await readRepositoryFile(repository, entry.path);
      const lines = file.content.split("\n");
      lines.forEach((line, index) => { if (results.length < 40 && line.toLowerCase().includes(safeQuery.toLowerCase())) results.push({ path: entry.path, line: index + 1, context: line.trim().slice(0, 180) }); });
    } catch { /* Skip binary, blocked, and oversized files during broad search. */ }
  }
  return results;
}

export async function retrieveRepositoryContext(repository: RepositoryRef, paths: string[], question: string): Promise<string> {
  const explicit = paths.filter((path) => path && !BLOCKED.test(path) && !SECRET_FILE.test(path)).slice(0, 5);
  const searchResults = await searchRepository(repository, question).catch(() => []);
  const searchPaths = searchResults.map((result) => result.path).filter((path) => !explicit.includes(path)).slice(0, 3);
  const selected = [...explicit, ...searchPaths].slice(0, 8);
  const snippets = await Promise.all(selected.map(async (path) => {
    try { const file = await readRepositoryFile(repository, path); return `### ${file.path}\n${file.content.slice(0, 24_000)}`; } catch { return ""; }
  }));
  return snippets.filter(Boolean).join("\n\n");
}

function redactSecrets(content: string): string {
  return content
    .replace(/(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})/g, "[REDACTED_SECRET]")
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE)[A-Z0-9_]*)\s*=\s*(['"]?)[^'"\n]+/gi, "$1=$2[REDACTED_SECRET]");
}

function languageFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", css: "css", html: "html", json: "json", md: "markdown", yml: "yaml", yaml: "yaml", py: "python", go: "go", rs: "rust" } as Record<string, string>)[extension ?? ""] ?? "text";
}