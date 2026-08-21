import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChangeProposal } from "../ai/change-proposal";

export type ExecutionStatus = "applied" | "validation_failed";
export type ExecutionResult = {
  status: ExecutionStatus;
  proposalId: string;
  files: string[];
  addedLines: number;
  removedLines: number;
  typecheck: string;
  build: string;
  message: string;
  canUndo: boolean;
};

export class PatchExecutionError extends Error {
  constructor(readonly code: "invalid_proposal" | "protected_file" | "unsafe_path" | "stale_file" | "binary_file" | "too_large" | "validation_failed" | "already_applied" | "not_found", message: string) {
    super(message);
  }
}

type Snapshot = { relativePath: string; absolutePath: string; content: string };
type Session = { proposal: ChangeProposal; snapshots: Snapshot[]; applied: boolean; undoAvailable: boolean };

const MAX_FILES = Number(process.env.COSMIC_MAX_PROPOSAL_FILES ?? 20);
const MAX_ADDED = Number(process.env.COSMIC_MAX_ADDED_LINES ?? 5_000);
const MAX_REMOVED = Number(process.env.COSMIC_MAX_REMOVED_LINES ?? 5_000);
const MAX_TEXT_BYTES = Number(process.env.COSMIC_MAX_MODIFIED_BYTES ?? 500_000);
const executionRoot = path.resolve(process.env.COSMIC_EXECUTION_ROOT ?? process.cwd());
const sessions = new Map<string, Session>();
const protectedPath = /(^|\/)(\.env(?:\..*)?|\.git|node_modules|credentials?|secrets?)(\/|$)|(^|\/).*?\.(pem|key|p12|pfx|crt)$/i;
const protectedAuth = /(^|\/)(authStore|AuthContext)\.(ts|tsx|js|jsx)$/;
const binaryExtension = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|mp[34-9]|exe|dll|so|dylib)$/i;
const sessionsCommands = [
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "cosmic build", args: ["--filter", "@workspace/cosmic-agent", "run", "build"] },
  { name: "api build", args: ["--filter", "@workspace/api-server", "run", "build"] },
];

export function registerProposal(proposal: ChangeProposal): void {
  if (proposal.files.length > MAX_FILES || proposal.addedLines > MAX_ADDED || proposal.removedLines > MAX_REMOVED || proposal.files.reduce((sum, file) => sum + Buffer.byteLength(file.originalCode) + Buffer.byteLength(file.proposedCode), 0) > MAX_TEXT_BYTES) {
    throw new PatchExecutionError("too_large", `Proposal exceeds safe limits: ${MAX_FILES} files, ${MAX_ADDED} added lines, ${MAX_REMOVED} removed lines, or ${MAX_TEXT_BYTES} bytes.`);
  }
  if (!proposal.proposalId) throw new PatchExecutionError("invalid_proposal", "Proposal identity is missing.");
  for (const file of proposal.files) {
    const relative = safeRelative(file.path);
    if (binaryExtension.test(relative) || file.originalCode.includes("\0") || file.proposedCode.includes("\0")) throw new PatchExecutionError("binary_file", `Binary file edits are not supported: ${file.path}`);
    if (Buffer.byteLength(file.proposedCode) > MAX_TEXT_BYTES) throw new PatchExecutionError("too_large", `File exceeds the safe size limit: ${file.path}`);
  }
  sessions.set(proposal.proposalId, { proposal, snapshots: [], applied: false, undoAvailable: false });
}

export async function executeProposal(proposalId: string): Promise<ExecutionResult> {
  const session = sessions.get(proposalId);
  if (!session) throw new PatchExecutionError("not_found", "This proposal is no longer available. Please regenerate it.");
  if (session.applied) throw new PatchExecutionError("already_applied", "This proposal has already been applied.");
  const snapshots: Snapshot[] = [];
  for (const file of session.proposal.files) {
    const relativePath = safeRelative(file.path);
    const absolutePath = path.join(executionRoot, relativePath);
    let current: string;
    try { current = await fs.readFile(absolutePath, "utf8"); } catch { throw new PatchExecutionError("not_found", `File not found in the local execution workspace: ${relativePath}`); }
    if (current !== file.originalCode) throw new PatchExecutionError("stale_file", "File changed since this proposal was generated. Please regenerate the proposal.");
    snapshots.push({ relativePath, absolutePath, content: current });
  }
  session.snapshots = snapshots;
  try {
    await writeAtomically(session.proposal.files, snapshots);
    const validation = await runValidation();
    if (!validation.ok) {
      await restoreSnapshots(snapshots);
      return { status: "validation_failed", proposalId, files: snapshots.map((item) => item.relativePath), addedLines: session.proposal.addedLines, removedLines: session.proposal.removedLines, typecheck: validation.typecheck, build: validation.build, message: validation.message, canUndo: false };
    }
    session.applied = true;
    session.undoAvailable = true;
    return { status: "applied", proposalId, files: snapshots.map((item) => item.relativePath), addedLines: session.proposal.addedLines, removedLines: session.proposal.removedLines, typecheck: validation.typecheck, build: validation.build, message: "Changes applied locally. Nothing has been committed or pushed.", canUndo: true };
  } catch (error) {
    await restoreSnapshots(snapshots);
    if (error instanceof PatchExecutionError) throw error;
    throw new PatchExecutionError("validation_failed", "Changes were rolled back because validation could not complete.");
  }
}

export async function undoProposal(proposalId: string): Promise<void> {
  const session = sessions.get(proposalId);
  if (!session?.applied || !session.undoAvailable) throw new PatchExecutionError("not_found", "No undo snapshot is available for this proposal.");
  for (const snapshot of session.snapshots) {
    const current = await fs.readFile(snapshot.absolutePath, "utf8");
    const applied = session.proposal.files.find((file) => safeRelative(file.path) === snapshot.relativePath)?.proposedCode;
    if (current !== applied) throw new PatchExecutionError("stale_file", "The file changed after application. Undo was not performed.");
  }
  await restoreSnapshots(session.snapshots);
  session.undoAvailable = false;
  session.applied = false;
}

function safeRelative(input: string): string {
  const normalizedInput = input.replaceAll("\\", "/");
  const relative = normalizedInput.replace(/^\/+/, "");
  if (!relative || normalizedInput.startsWith("/") || relative.startsWith("../") || relative.includes("/../") || path.isAbsolute(input) || protectedPath.test(relative) || protectedAuth.test(relative)) {
    if (protectedPath.test(relative) || protectedAuth.test(relative)) throw new PatchExecutionError("protected_file", `Protected files cannot be changed: ${input}`);
    throw new PatchExecutionError("unsafe_path", `Unsafe target path rejected: ${input}`);
  }
  return relative;
}

async function writeAtomically(files: ChangeProposal["files"], snapshots: Snapshot[]): Promise<void> {
  const tempFiles: string[] = [];
  try {
    for (const file of files) {
      const snapshot = snapshots.find((item) => item.relativePath === safeRelative(file.path));
      if (!snapshot) throw new PatchExecutionError("invalid_proposal", "Proposal file snapshot mismatch.");
      const temp = `${snapshot.absolutePath}.cosmic-${process.pid}-${Date.now()}.tmp`;
      await fs.writeFile(temp, file.proposedCode, "utf8");
      tempFiles.push(temp);
    }
    for (let i = 0; i < files.length; i++) await fs.rename(tempFiles[i], snapshots[i].absolutePath);
  } finally {
    await Promise.all(tempFiles.map((temp) => fs.unlink(temp).catch(() => undefined)));
  }
}

async function restoreSnapshots(snapshots: Snapshot[]): Promise<void> {
  await Promise.all(snapshots.map((snapshot) => fs.writeFile(snapshot.absolutePath, snapshot.content, "utf8")));
}

async function runValidation(): Promise<{ ok: boolean; typecheck: string; build: string; message: string }> {
  let typecheck = "Not run";
  let build = "Not run";
  for (const command of sessionsCommands) {
    const result = await runFixedCommand(command.args);
    if (command.name === "typecheck") typecheck = result.output;
    else build = build === "Not run" ? result.output : `${build}\n${result.output}`;
    if (!result.ok) return { ok: false, typecheck, build, message: `${command.name} failed. Changes were rolled back.` };
  }
  return { ok: true, typecheck: "Passed", build: "Passed", message: "Validation passed." };
}

function runFixedCommand(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", args, {
      cwd: executionRoot,
      shell: false,
      env: {
        ...process.env,
        PORT: process.env.PORT ?? "4173",
        BASE_PATH: process.env.BASE_PATH ?? "/",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("close", (code) => resolve({ ok: code === 0, output: code === 0 ? "Passed" : output.slice(-1200) }));
    child.on("error", () => resolve({ ok: false, output: "Validation command could not start." }));
  });
}