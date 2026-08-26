import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(process.env.COSMIC_WORKSPACE_ROOT ?? path.join(process.cwd(), ".cosmic-workspaces"));
const blocked = /(^|\/)(\.git|node_modules|\.env(?:\..*)?|secrets?|credentials?)(\/|$)|(^|\/).*?\.(pem|key|p12|pfx|crt)$/i;
const protectedAuth = /(^|\/)(authStore|AuthContext)\.(ts|tsx|js|jsx)$/;
const binary = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|mp[34-9]|exe|dll|so|dylib)$/i;

export type WorkspaceFile = { path: string; type: "file" | "directory"; size?: number; modifiedAt?: string };
export type WorkspaceInspection = {
  structure: WorkspaceFile[];
  relevantFiles: string[];
  entryPoints: string[];
  dependencies: { name: string; version: string; kind: "dependency" | "devDependency" }[];
  filesRead: string[];
  context: string;
};

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
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).filter((entry) => {
    const candidate = path.posix.join(safe.replaceAll("\\", "/"), entry.name);
    return !blocked.test(candidate) && !entry.isSymbolicLink();
  }).map(async (entry) => {
    const relativePath = path.posix.join(safe.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) return { path: relativePath, type: "directory" as const };
    const stat = await fs.stat(path.join(directory, entry.name));
    return { path: relativePath, type: "file" as const, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }));
}

export async function readWorkspaceFile(userId: string, projectId: string, relative: string): Promise<{ path: string; content: string; size: number }> {
  const base = await ensureWorkspace(userId, projectId);
  const safe = safeWorkspaceRelative(relative);
  const stat = await fs.stat(path.join(base, safe));
  if (!stat.isFile()) throw new Error("Only regular text files can be read.");
  if (stat.size > 500_000) throw new Error("Workspace file is too large to read.");
  const content = await fs.readFile(path.join(base, safe), "utf8");
  return { path: safe, content, size: Buffer.byteLength(content) };
}

export async function writeWorkspaceFile(userId: string, projectId: string, relative: string, content: string): Promise<WorkspaceFile> {
  if (typeof content !== "string" || Buffer.byteLength(content) > 500_000) throw new Error("Workspace files must be text smaller than 500 KB.");
  const base = await ensureWorkspace(userId, projectId);
  const safe = safeWorkspaceRelative(relative);
  assertWritablePath(safe);
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
  assertWritablePath(safe);
  await fs.rm(path.join(base, safe), { recursive: true, force: false });
}

export async function createWorkspaceDirectory(userId: string, projectId: string, relative: string): Promise<void> {
  const base = await ensureWorkspace(userId, projectId);
  const safe = safeWorkspaceRelative(relative);
  assertWritablePath(safe);
  await fs.mkdir(path.join(base, safe), { recursive: true });
}

export async function renameWorkspacePath(userId: string, projectId: string, from: string, to: string): Promise<void> {
  const base = await ensureWorkspace(userId, projectId);
  const source = safeWorkspaceRelative(from);
  const target = safeWorkspaceRelative(to);
  assertWritablePath(source);
  assertWritablePath(target);
  const absoluteSource = path.join(base, source);
  const absoluteTarget = path.join(base, target);
  await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
  await fs.rename(absoluteSource, absoluteTarget);
}

function assertWritablePath(relative: string): void {
  if (protectedAuth.test(relative)) throw new Error("Protected authentication paths cannot be changed.");
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

export async function inspectWorkspace(userId: string, projectId: string, requestedPaths: string[] = [], request = ""): Promise<WorkspaceInspection> {
  const structure: WorkspaceFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    if (structure.length >= 500) return;
    for (const entry of await listWorkspace(userId, projectId, relative)) {
      structure.push(entry);
      if (entry.type === "directory") await walk(entry.path);
      if (structure.length >= 500) return;
    }
  };
  await walk("");
  const filePaths = structure.filter((entry) => entry.type === "file").map((entry) => entry.path);
  const explicit = requestedPaths.map((item) => safeWorkspaceRelative(item)).filter((item) => filePaths.includes(item));
  const searchTerms = request.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  const matches = new Set<string>();
  for (const term of [...new Set(searchTerms)].slice(0, 12)) {
    for (const result of await searchWorkspace(userId, projectId, term)) matches.add(result.path);
  }
  const entryPoints = filePaths.filter((item) =>
    /(^|\/)(index\.html|package\.json|vite\.config\.[cm]?[jt]s|tsconfig\.json|src\/(main|app)\.[cm]?[jt]sx?|app\.[cm]?js|style\.css|styles\.css|readme(?:\.md)?)$/i.test(item),
  );
  const relevantFiles = [...new Set([...explicit, ...entryPoints, ...matches])].slice(0, 20);
  const filesRead: string[] = [];
  const snippets: string[] = [];
  const dependencies: WorkspaceInspection["dependencies"] = [];
  for (const item of relevantFiles) {
    try {
      const file = await readWorkspaceFile(userId, projectId, item);
      filesRead.push(file.path);
      snippets.push(`### FILE: ${file.path}\n${file.content.slice(0, 12_000)}`);
      if (item === "package.json" || item.endsWith("/package.json")) {
        try {
          const manifest = JSON.parse(file.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          for (const kind of ["dependency", "devDependency"] as const) {
            const values = kind === "dependency" ? manifest.dependencies : manifest.devDependencies;
            for (const [name, version] of Object.entries(values ?? {})) dependencies.push({ name, version, kind });
          }
        } catch {
          snippets.push("Manifest is not valid JSON.");
        }
      }
    } catch {
      // A file can disappear between the bounded listing and the read. It is
      // intentionally omitted rather than represented as fabricated context.
    }
  }
  const structureText = structure.slice(0, 300).map((item) => `${item.type === "directory" ? "DIR " : "FILE"} ${item.path}`).join("\n") || "(empty workspace)";
  const dependencyText = dependencies.length ? dependencies.map((item) => `${item.name}@${item.version} (${item.kind})`).join(", ") : "(none discovered)";
  return {
    structure,
    relevantFiles,
    entryPoints,
    dependencies: dependencies.slice(0, 120),
    filesRead,
    context: `PROJECT STRUCTURE\n${structureText}\n\nENTRY POINTS\n${entryPoints.join(", ") || "(none discovered)"}\n\nDEPENDENCIES\n${dependencyText}\n\nRELEVANT FILE CONTENT\n${snippets.join("\n\n") || "(no readable source files yet)"}`.slice(0, 64_000),
  };
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
  return createHash("sha256").update(`${workspaceIdentity}\n${files.map((file) => `${file.path}\0${"operation" in file ? String(file.operation) : ""}\0${"fromPath" in file ? String(file.fromPath ?? "") : ""}\0${file.proposedCode}`).join("\n")}`).digest("hex").slice(0, 16);
}