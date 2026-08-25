import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(process.env.COSMIC_WORKSPACE_ROOT ?? path.join(process.cwd(), ".cosmic-workspaces"));
const blocked = /(^|\/)(\.git|node_modules|\.env(?:\..*)?|secrets?|credentials?)(\/|$)|(^|\/).*?\.(pem|key|p12|pfx|crt)$/i;
const binary = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|mp[34-9]|exe|dll|so|dylib)$/i;

export type WorkspaceFile = { path: string; type: "file" | "directory"; size?: number; modifiedAt?: string };

export function workspacePath(userId: string, projectId: string): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "default";
  return path.join(root, clean(userId), clean(projectId));
}

export function safeWorkspaceRelative(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || input.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(input) || blocked.test(normalized) || binary.test(normalized)) {
    throw new Error("Unsafe workspace path rejected.");
  }
  return normalized;
}

export async function ensureWorkspace(userId: string, projectId: string): Promise<string> {
  const directory = workspacePath(userId, projectId);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

export async function listWorkspace(userId: string, projectId: string, relative = ""): Promise<WorkspaceFile[]> {
  const base = await ensureWorkspace(userId, projectId);
  const safe = relative ? safeWorkspaceRelative(relative) : "";
  const directory = path.join(base, safe);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    const relativePath = path.posix.join(safe.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) return { path: relativePath, type: "directory" as const };
    const stat = await fs.stat(path.join(directory, entry.name));
    return { path: relativePath, type: "file" as const, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }));
}

export async function readWorkspaceFile(userId: string, projectId: string, relative: string): Promise<{ path: string; content: string; size: number }> {
  const base = await ensureWorkspace(userId, projectId);
  const safe = safeWorkspaceRelative(relative);
  const content = await fs.readFile(path.join(base, safe), "utf8");
  return { path: safe, content, size: Buffer.byteLength(content) };
}

export async function writeWorkspaceFile(userId: string, projectId: string, relative: string, content: string): Promise<WorkspaceFile> {
  if (typeof content !== "string" || Buffer.byteLength(content) > 500_000) throw new Error("Workspace files must be text smaller than 500 KB.");
  const base = await ensureWorkspace(userId, projectId);
  const safe = safeWorkspaceRelative(relative);
  const absolute = path.join(base, safe);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.cosmic-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, absolute);
  const stat = await fs.stat(absolute);
  return { path: safe, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

export async function removeWorkspacePath(userId: string, projectId: string, relative: string): Promise<void> {
  const base = await ensureWorkspace(userId, projectId);
  const safe = safeWorkspaceRelative(relative);
  await fs.rm(path.join(base, safe), { recursive: true, force: false });
}

export async function createWorkspaceDirectory(userId: string, projectId: string, relative: string): Promise<void> {
  const base = await ensureWorkspace(userId, projectId);
  const safe = safeWorkspaceRelative(relative);
  await fs.mkdir(path.join(base, safe), { recursive: true });
}

export async function renameWorkspacePath(userId: string, projectId: string, from: string, to: string): Promise<void> {
  const base = await ensureWorkspace(userId, projectId);
  const source = safeWorkspaceRelative(from);
  const target = safeWorkspaceRelative(to);
  const absoluteSource = path.join(base, source);
  const absoluteTarget = path.join(base, target);
  await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
  await fs.rename(absoluteSource, absoluteTarget);
}

export async function searchWorkspace(userId: string, projectId: string, query: string): Promise<Array<{ path: string; line: number; context: string }>> {
  const results: Array<{ path: string; line: number; context: string }> = [];
  const walk = async (relative: string): Promise<void> => {
    for (const item of await listWorkspace(userId, projectId, relative)) {
      if (item.type === "directory") await walk(item.path);
      else if (item.size && item.size <= 240_000) {
        const file = await readWorkspaceFile(userId, projectId, item.path);
        file.content.split("\n").forEach((line, index) => {
          if (line.toLowerCase().includes(query.toLowerCase())) results.push({ path: item.path, line: index + 1, context: line.slice(0, 300) });
        });
      }
    }
  };
  if (!query.trim()) return [];
  await walk("");
  return results.slice(0, 100);
}

export function changeStats(original: string, proposed: string) {
  const oldLines = original.split("\n");
  const newLines = proposed.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  return { removedLines: oldLines.length - prefix - suffix, addedLines: newLines.length - prefix - suffix };
}

export function workspaceProposalId(files: Array<{ path: string; proposedCode: string }>, workspaceIdentity = ""): string {
  return createHash("sha256").update(`${workspaceIdentity}\n${files.map((file) => `${file.path}\0${file.proposedCode}`).join("\n")}`).digest("hex").slice(0, 16);
}