import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChangeProposal } from "../ai/change-proposal";
import type { RepositoryRef } from "./github-provider";
import { githubWriteProvider } from "./github-write-provider";

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

type Snapshot = { relativePath: string; absolutePath: string; content: string };
type Session = {
  proposal: ChangeProposal;
  repository?: RepositoryRef;
  snapshots: Snapshot[];
  applied: boolean;
  undoAvailable: boolean;
  validated: boolean;
  commit?: CommitResult;
  commitBaseSha?: string;
};

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

export function registerProposal(proposal: ChangeProposal, repository?: RepositoryRef): void {
  if (proposal.files.length > MAX_FILES || proposal.addedLines > MAX_ADDED || proposal.removedLines > MAX_REMOVED || proposal.files.reduce((sum, file) => sum + Buffer.byteLength(file.originalCode) + Buffer.byteLength(file.proposedCode), 0) > MAX_TEXT_BYTES) {
    throw new PatchExecutionError("too_large", `Proposal exceeds safe limits: ${MAX_FILES} files, ${MAX_ADDED} added lines, ${MAX_REMOVED} removed lines, or ${MAX_TEXT_BYTES} bytes.`);
  }
  if (!proposal.proposalId) throw new PatchExecutionError("invalid_proposal", "Proposal identity is missing.");
  for (const file of proposal.files) {
    const relative = safeRelative(file.path);
    if (binaryExtension.test(relative) || file.originalCode.includes("\0") || file.proposedCode.includes("\0")) throw new PatchExecutionError("binary_file", `Binary file edits are not supported: ${file.path}`);
    if (Buffer.byteLength(file.proposedCode) > MAX_TEXT_BYTES) throw new PatchExecutionError("too_large", `File exceeds the safe size limit: ${file.path}`);
  }
  sessions.set(proposal.proposalId, { proposal, repository, snapshots: [], applied: false, undoAvailable: false, validated: false });
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
    session.validated = true;
    session.undoAvailable = true;
    return { status: "applied", proposalId, files: snapshots.map((item) => item.relativePath), addedLines: session.proposal.addedLines, removedLines: session.proposal.removedLines, typecheck: validation.typecheck, build: validation.build, message: "Changes applied locally. Nothing has been committed or pushed.", canUndo: true };
  } catch (error) {
    await restoreSnapshots(snapshots);
    if (error instanceof PatchExecutionError) throw error;
    throw new PatchExecutionError("validation_failed", "Changes were rolled back because validation could not complete.");
  }
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

export async function commitProposal(proposalId: string, message: string): Promise<CommitResult> {
  const review = await getCommitReview(proposalId);
  const session = sessions.get(proposalId);
  if (!session) throw new PatchExecutionError("not_found", "This proposal is no longer available.");
  const cleanMessage = message.trim();
  if (!cleanMessage || cleanMessage.length > 200) throw new PatchExecutionError("invalid_proposal", "Enter a commit message between 1 and 200 characters.");
  const state = await githubWriteProvider.getRepositoryState(review.repository, review.branch);
  const comparison = await githubWriteProvider.compareBranch(review.repository, review.branch, state.headSha);
  if (!comparison.unchanged) throw new PatchExecutionError("validation_failed", "Remote branch changed. Commit was cancelled to protect existing work.");
  const committed = await githubWriteProvider.createCommit({
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

export async function pushProposal(proposalId: string): Promise<PushResult> {
  const review = getPushReview(proposalId);
  const session = sessions.get(proposalId);
  if (!session?.commit) throw new PatchExecutionError("invalid_proposal", "A successful commit approval is required before push.");
  const expectedHeadSha = session.commitBaseSha;
  if (!expectedHeadSha) throw new PatchExecutionError("invalid_proposal", "The approved commit state is incomplete. Push was cancelled.");
  const comparison = await githubWriteProvider.compareBranch(review.repository, review.branch, expectedHeadSha);
  if (!comparison.unchanged) throw new PatchExecutionError("validation_failed", "Remote branch changed. Push was cancelled to protect existing work.");
  const pushed = await githubWriteProvider.pushBranch(review.repository, review.branch, expectedHeadSha, session.commit.commitSha);
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

async function verifyValidatedFiles(session: Session): Promise<void> {
  if (session.proposal.files.length !== session.snapshots.length) {
    throw new PatchExecutionError("invalid_proposal", "The validated file set no longer matches the approved proposal.");
  }
  for (const snapshot of session.snapshots) {
    const file = session.proposal.files.find((candidate) => safeRelative(candidate.path) === snapshot.relativePath);
    if (!file || file.proposedCode.includes("\0") || protectedPath.test(snapshot.relativePath) || protectedAuth.test(snapshot.relativePath)) {
      throw new PatchExecutionError("protected_file", "Protected or invalid files cannot be committed.");
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