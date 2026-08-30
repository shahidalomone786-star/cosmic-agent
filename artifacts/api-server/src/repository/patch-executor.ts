import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChangeProposal } from "../ai/change-proposal";
import { invalidateRepositoryContext, type RepositoryRef } from "./github-provider";
import { githubWriteProvider, type GitHubWriteProvider } from "./github-write-provider";
import { assertApproval, type ProposalApproval } from "../ai/approval-gate";

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

export type CommitReviewResult = {
  status: "ready_to_commit";
  proposalId: string;
  repository: RepositoryRef;
  branch: string;
  files: string[];
  addedLines: number;
  removedLines: number;
  diffSummary: string;
  validation: "passed";
};

export type CommitResult = {
  status: "committed";
  proposalId: string;
  repository: RepositoryRef;
  branch: string;
  commitSha: string;
  shortSha: string;
};

export type PushReviewResult = {
  status: "ready_to_push";
  proposalId: string;
  repository: RepositoryRef;
  branch: string;
  commitSha: string;
  shortSha: string;
};

export type PushResult = {
  status: "pushed";
  proposalId: string;
  repository: RepositoryRef;
  branch: string;
  commitSha: string;
  shortSha: string;
};

export class PatchExecutionError extends Error {
  constructor(readonly code: "invalid_proposal" | "protected_file" | "unsafe_path" | "stale_file" | "binary_file" | "too_large" | "validation_failed" | "already_applied" | "not_found", message: string) {
    super(message);
  }
}

type Snapshot = {
  relativePath: string;
  absolutePath: string;
  sourceRelativePath?: string;
  sourceAbsolutePath?: string;
  content: string;
  exists: boolean;
  targetExists: boolean;
  operation: ChangeProposal["files"][number]["operation"];
};
type Session = {
  proposal: ChangeProposal;
  repository?: RepositoryRef;
  provider?: "groq" | "gemini";
  snapshots: Snapshot[];
  applied: boolean;
  undoAvailable: boolean;
  validated: boolean;
  commit?: CommitResult;
  commitBaseSha?: string;
  approval?: ProposalApproval;
  staged: boolean;
  workspaceRoot?: string;
  ownerId?: string;
  projectId?: string;
};

const MAX_FILES = Number(process.env.COSMIC_MAX_PROPOSAL_FILES ?? 20);
const MAX_ADDED = Number(process.env.COSMIC_MAX_ADDED_LINES ?? 5_000);
const MAX_REMOVED = Number(process.env.COSMIC_MAX_REMOVED_LINES ?? 5_000);
const MAX_TEXT_BYTES = Number(process.env.COSMIC_MAX_MODIFIED_BYTES ?? 500_000);
function findWorkspaceRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}
const executionRoot = path.resolve(process.env.COSMIC_EXECUTION_ROOT ?? findWorkspaceRoot());
const sessions = new Map<string, Session>();
const protectedPath = /(^|\/)(\.env(?:\..*)?|\.git|node_modules|credentials?|secrets?)(\/|$)|(^|\/).*?\.(pem|key|p12|pfx|crt)$/i;
const protectedAuth = /(^|\/)(authStore|AuthContext)\.(ts|tsx|js|jsx)$/;
const binaryExtension = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|mp[34-9]|exe|dll|so|dylib)$/i;
const sessionsCommands = [
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "cosmic build", args: ["--filter", "@workspace/cosmic-agent", "run", "build"] },
  { name: "api build", args: ["--filter", "@workspace/api-server", "run", "build"] },
];

export function registerProposal(proposal: ChangeProposal, repository?: RepositoryRef, provider?: "groq" | "gemini", workspaceRoot?: string, ownerId?: string, projectId?: string): void {
  if (proposal.files.length > MAX_FILES || proposal.addedLines > MAX_ADDED || proposal.removedLines > MAX_REMOVED || proposal.files.reduce((sum, file) => sum + Buffer.byteLength(file.originalCode) + Buffer.byteLength(file.proposedCode), 0) > MAX_TEXT_BYTES) {
    throw new PatchExecutionError("too_large", `Proposal exceeds safe limits: ${MAX_FILES} files, ${MAX_ADDED} added lines, ${MAX_REMOVED} removed lines, or ${MAX_TEXT_BYTES} bytes.`);
  }
  if (!proposal.proposalId) throw new PatchExecutionError("invalid_proposal", "Proposal identity is missing.");
  for (const file of proposal.files) {
    const relative = safeRelative(file.path);
    if (binaryExtension.test(relative) || file.originalCode.includes("\0") || file.proposedCode.includes("\0")) throw new PatchExecutionError("binary_file", `Binary file edits are not supported: ${file.path}`);
    if (file.fromPath) safeRelative(file.fromPath);
    if (Buffer.byteLength(file.proposedCode) > MAX_TEXT_BYTES) throw new PatchExecutionError("too_large", `File exceeds the safe size limit: ${file.path}`);
  }
  sessions.set(proposal.proposalId, { proposal, repository, provider, workspaceRoot, ownerId, projectId, snapshots: [], applied: false, undoAvailable: false, validated: false, staged: false });
}

export function getRegisteredProposal(proposalId: string): { proposal: ChangeProposal; repository?: RepositoryRef; provider?: "groq" | "gemini"; workspaceRoot?: string; ownerId?: string; projectId?: string } | undefined {
  const session = sessions.get(proposalId);
  return session ? { proposal: session.proposal, repository: session.repository, provider: session.provider, workspaceRoot: session.workspaceRoot, ownerId: session.ownerId, projectId: session.projectId } : undefined;
}

export function isProposalPreviewable(proposalId: string): boolean {
  const session = sessions.get(proposalId);
  return Boolean(session?.applied && session.validated);
}

export function findWorkspaceProposal(ownerId: string, projectId: string): string | undefined {
  const matches = [...sessions.entries()].filter(([, session]) => session.ownerId === ownerId && session.projectId === projectId && session.workspaceRoot);
  return matches.at(-1)?.[0];
}

export async function executeProposal(proposalId: string, approvalId?: string): Promise<ExecutionResult> {
  const session = sessions.get(proposalId);
  if (!session) throw new PatchExecutionError("not_found", "This proposal is no longer available. Please regenerate it.");
  if (!approvalId) throw new PatchExecutionError("invalid_proposal", "Explicit user approval is required before applying this proposal.");
  try {
    session.approval = assertApproval(approvalId, session.proposal, session.repository);
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      const code = (error as { code: string }).code;
      if (code === "stale_proposal") throw new PatchExecutionError("stale_file", error.message);
    }
    throw new PatchExecutionError("invalid_proposal", error instanceof Error ? error.message : "The approval could not be verified.");
  }
  if (session.applied) throw new PatchExecutionError("already_applied", "This proposal has already been applied.");
  const snapshots: Snapshot[] = [];
  for (const file of session.proposal.files) {
    const relativePath = safeRelative(file.path);
    const absolutePath = path.join(session.workspaceRoot ?? executionRoot, relativePath);
    const sourceRelativePath = file.operation === "rename" ? safeRelative(file.fromPath ?? "") : relativePath;
    const sourceAbsolutePath = path.join(session.workspaceRoot ?? executionRoot, sourceRelativePath);
    const sourceExists = await pathExists(sourceAbsolutePath);
    const targetExists = await pathExists(absolutePath);
    const current = sourceExists && file.operation === "rename" ? await readText(sourceAbsolutePath) : targetExists ? await readText(absolutePath) : "";
    if (file.operation === "create" || file.operation === "directory_create") {
      if (targetExists) throw new PatchExecutionError("stale_file", `New path already exists: ${relativePath}`);
    } else if (file.operation === "rename") {
      if (!sourceExists) throw new PatchExecutionError("not_found", `File not found in the local execution workspace: ${sourceRelativePath}`);
      if (targetExists) throw new PatchExecutionError("stale_file", `Rename target already exists: ${relativePath}`);
      if (current !== file.originalCode) throw new PatchExecutionError("stale_file", "File changed since this proposal was generated. Please regenerate the proposal.");
    } else {
      if (!targetExists) throw new PatchExecutionError("not_found", `File not found in the local execution workspace: ${relativePath}`);
      if (current !== file.originalCode) throw new PatchExecutionError("stale_file", "File changed since this proposal was generated. Please regenerate the proposal.");
    }
    snapshots.push({ relativePath, absolutePath, sourceRelativePath: file.operation === "rename" ? sourceRelativePath : undefined, sourceAbsolutePath: file.operation === "rename" ? sourceAbsolutePath : undefined, content: current, exists: sourceExists, targetExists, operation: file.operation });
  }
  session.snapshots = snapshots;
  try {
    await writeAtomically(session.proposal.files, snapshots);
    session.applied = true;
    session.validated = false;
    session.undoAvailable = true;
    return { status: "applied", proposalId, files: snapshots.map((item) => item.relativePath), addedLines: session.proposal.addedLines, removedLines: session.proposal.removedLines, typecheck: "not-verified", build: "not-verified", message: "Changes applied locally. Deterministic validation is required before commit review.", canUndo: true };
  } catch (error) {
    await restoreSnapshots(snapshots);
    if (error instanceof PatchExecutionError) throw error;
    throw new PatchExecutionError("validation_failed", "Changes were rolled back because validation could not complete.");
  }
}

export async function rejectAppliedProposal(proposalId: string): Promise<void> {
  const session = sessions.get(proposalId);
  if (!session?.applied) throw new PatchExecutionError("invalid_proposal", "There is no applied proposal to roll back.");
  await restoreSnapshots(session.snapshots);
  session.applied = false;
  session.validated = false;
  session.undoAvailable = false;
}

export function markProposalValidated(proposalId: string, validated: boolean): void {
  const session = sessions.get(proposalId);
  if (!session?.applied) throw new PatchExecutionError("invalid_proposal", "Only an applied proposal can be validated.");
  session.validated = validated;
  if (!validated) session.staged = false;
  if (!validated) session.undoAvailable = false;
}

export async function stageProposal(proposalId: string, approvalId: string): Promise<{ status: "staged"; proposalId: string; files: string[] }> {
  const session = sessions.get(proposalId);
  if (!session?.applied || !session.validated || !session.repository) {
    throw new PatchExecutionError("invalid_proposal", "Only a successfully validated approved change can be staged.");
  }
  if (!approvalId) throw new PatchExecutionError("invalid_proposal", "Explicit user approval is required before staging.");
  try {
    session.approval = assertApproval(approvalId, session.proposal, session.repository, undefined, "apply");
  } catch (error) {
    throw new PatchExecutionError("invalid_proposal", error instanceof Error ? error.message : "The approval could not be verified.");
  }
  await verifyValidatedFiles(session);
  session.staged = true;
  return { status: "staged", proposalId, files: session.snapshots.map((snapshot) => snapshot.relativePath) };
}

export async function getCommitReview(proposalId: string): Promise<CommitReviewResult> {
  const session = sessions.get(proposalId);
  if (!session || !session.applied || !session.validated || !session.repository) {
    throw new PatchExecutionError("invalid_proposal", "Only a successfully validated approved change can enter commit review.");
  }
  await verifyValidatedFiles(session);
  return {
    status: "ready_to_commit",
    proposalId,
    repository: session.repository,
    branch: session.repository.branch,
    files: session.snapshots.map((snapshot) => snapshot.relativePath),
    addedLines: session.proposal.addedLines,
    removedLines: session.proposal.removedLines,
    diffSummary: `${session.proposal.addedLines} additions and ${session.proposal.removedLines} removals across ${session.snapshots.length} files.`,
    validation: "passed",
  };
}

export async function commitProposal(proposalId: string, approvalId: string, message: string, provider: GitHubWriteProvider = githubWriteProvider): Promise<CommitResult> {
  const review = await getCommitReview(proposalId);
  const session = sessions.get(proposalId);
  if (!session) throw new PatchExecutionError("not_found", "This proposal is no longer available.");
  if (!session.staged) throw new PatchExecutionError("invalid_proposal", "The approved proposal must be staged before commit.");
  if (!approvalId) throw new PatchExecutionError("invalid_proposal", "Explicit commit approval is required.");
  try {
    assertApproval(approvalId, session.proposal, session.repository, undefined, "commit");
  } catch (error) {
    throw new PatchExecutionError("invalid_proposal", error instanceof Error ? error.message : "The commit approval could not be verified.");
  }
  const cleanMessage = message.trim();
  if (!cleanMessage || cleanMessage.length > 200) throw new PatchExecutionError("invalid_proposal", "Enter a commit message between 1 and 200 characters.");
  const state = await provider.getRepositoryState(review.repository, review.branch);
  const comparison = await provider.compareBranch(review.repository, review.branch, state.headSha);
  if (!comparison.unchanged) throw new PatchExecutionError("validation_failed", "Remote branch changed. Commit was cancelled to protect existing work.");
  const committed = await provider.createCommit({
    repository: review.repository,
    branch: review.branch,
    expectedHeadSha: state.headSha,
    message: cleanMessage,
    files: session.snapshots.map((snapshot) => ({
      path: snapshot.relativePath,
      content: session.proposal.files.find((file) => safeRelative(file.path) === snapshot.relativePath)?.proposedCode ?? "",
    })),
  });
  session.commit = { status: "committed", ...committed, proposalId };
  session.commitBaseSha = state.headSha;
  return session.commit;
}

export function getPushReview(proposalId: string): PushReviewResult {
  const session = sessions.get(proposalId);
  if (!session?.commit) throw new PatchExecutionError("invalid_proposal", "A successful commit approval is required before push review.");
  return {
    status: "ready_to_push",
    proposalId,
    repository: session.commit.repository,
    branch: session.commit.branch,
    commitSha: session.commit.commitSha,
    shortSha: session.commit.shortSha,
  };
}

export async function pushProposal(proposalId: string, approvalId: string, provider: GitHubWriteProvider = githubWriteProvider): Promise<PushResult> {
  const review = getPushReview(proposalId);
  const session = sessions.get(proposalId);
  if (!session?.commit) throw new PatchExecutionError("invalid_proposal", "A successful commit approval is required before push.");
  if (!approvalId) throw new PatchExecutionError("invalid_proposal", "Explicit push approval is required.");
  try {
    assertApproval(approvalId, session.proposal, session.repository, undefined, "push");
  } catch (error) {
    throw new PatchExecutionError("invalid_proposal", error instanceof Error ? error.message : "The push approval could not be verified.");
  }
  const expectedHeadSha = session.commitBaseSha;
  if (!expectedHeadSha) throw new PatchExecutionError("invalid_proposal", "The approved commit state is incomplete. Push was cancelled.");
  const comparison = await provider.compareBranch(review.repository, review.branch, expectedHeadSha);
  if (!comparison.unchanged) throw new PatchExecutionError("validation_failed", "Remote branch changed. Push was cancelled to protect existing work.");
  const pushed = await provider.pushBranch(review.repository, review.branch, expectedHeadSha, session.commit.commitSha);
  invalidateRepositoryContext(review.repository);
  return { status: "pushed", ...pushed, proposalId };
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
      if (file.operation === "directory_create") {
        await fs.mkdir(snapshot.absolutePath, { recursive: true });
      } else if (file.operation === "delete") {
        await fs.rm(snapshot.absolutePath, { recursive: false, force: false });
      } else if (file.operation === "rename") {
        await fs.mkdir(path.dirname(snapshot.absolutePath), { recursive: true });
        await fs.rename(snapshot.sourceAbsolutePath!, snapshot.absolutePath);
      } else {
        await fs.mkdir(path.dirname(snapshot.absolutePath), { recursive: true });
        const temp = `${snapshot.absolutePath}.cosmic-${process.pid}-${Date.now()}.tmp`;
        await fs.writeFile(temp, file.proposedCode, "utf8");
        tempFiles.push(temp);
        await fs.rename(temp, snapshot.absolutePath);
      }
    }
  } finally {
    await Promise.all(tempFiles.map((temp) => fs.unlink(temp).catch(() => undefined)));
  }
}

async function restoreSnapshots(snapshots: Snapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.operation === "rename") {
      if (await pathExists(snapshot.absolutePath)) {
        await fs.mkdir(path.dirname(snapshot.sourceAbsolutePath!), { recursive: true });
        await fs.rename(snapshot.absolutePath, snapshot.sourceAbsolutePath!);
      }
      continue;
    }
    if (snapshot.operation === "directory_create") {
      if (await pathExists(snapshot.absolutePath)) {
        try { await fs.rmdir(snapshot.absolutePath); } catch (error) {
          throw new PatchExecutionError("stale_file", "A created directory is no longer empty; it was not removed.");
        }
      }
      continue;
    }
    if (snapshot.operation === "delete" || snapshot.operation === "edit") {
      await fs.mkdir(path.dirname(snapshot.absolutePath), { recursive: true });
      await fs.writeFile(snapshot.absolutePath, snapshot.content, "utf8");
    } else {
      await fs.unlink(snapshot.absolutePath).catch(() => undefined);
    }
  }
}

async function verifyValidatedFiles(session: Session): Promise<void> {
  if (session.proposal.files.length !== session.snapshots.length) {
    throw new PatchExecutionError("invalid_proposal", "The validated file set no longer matches the approved proposal.");
  }
  for (const snapshot of session.snapshots) {
    const file = session.proposal.files.find((candidate) => safeRelative(candidate.path) === snapshot.relativePath);
    if (!file || file.proposedCode.includes("\0") || protectedPath.test(snapshot.relativePath) || protectedAuth.test(snapshot.relativePath)) {
      throw new PatchExecutionError("protected_file", "Protected or invalid files cannot be committed.");
    }
    if (file.operation === "delete" || file.operation === "rename" || file.operation === "directory_create") {
      throw new PatchExecutionError("invalid_proposal", "Only file create/edit proposals can be committed to GitHub.");
    }
    let current: string;
    try {
      current = await fs.readFile(snapshot.absolutePath, "utf8");
    } catch {
      throw new PatchExecutionError("stale_file", "A validated file is no longer available. Commit was cancelled.");
    }
    if (current !== file.proposedCode) {
      throw new PatchExecutionError("stale_file", "A validated file changed after validation. Commit was cancelled.");
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch { return false; }
}

async function readText(target: string): Promise<string> {
  try { return await fs.readFile(target, "utf8"); }
  catch { throw new PatchExecutionError("binary_file", `The workspace path is not a readable text file: ${target}`); }
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