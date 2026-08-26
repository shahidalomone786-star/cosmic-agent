import type { AiProvider } from "../ai/ai-provider";
import type { ChangeProposal, ChangeProposalFile } from "../ai/change-proposal";
import { ProposalError } from "../ai/change-proposal";
import { workspaceProposalId, inspectWorkspace, readWorkspaceFile, safeWorkspaceRelative, type WorkspaceInspection } from "./local-workspace";

type ModelLocalProposal = {
  summary?: unknown;
  explanation?: unknown;
  risk?: unknown;
  plan?: unknown;
  validationPlan?: unknown;
  files?: unknown;
};

const MAX_FILES = 20;
const PROTECTED_PATH = /(^|\/)(\.env(?:\..*)?|\.git|node_modules|credentials?|secrets?)(\/|$)|(^|\/).*?\.(pem|key|p12|pfx|crt)$/i;
const SECRET_LIKE = /(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"']{8,})/i;

export type LocalProposalResult = {
  proposal: ChangeProposal;
  inspection: WorkspaceInspection;
};

export async function createLocalProposal(
  provider: AiProvider,
  model: string,
  userId: string,
  projectId: string,
  request: string,
  requestedPaths: string[] = [],
  previousErrors: string[] = [],
): Promise<LocalProposalResult> {
  const inspection = await inspectWorkspace(userId, projectId, requestedPaths, request);
  const prompt = [
    "You are the coding agent for a private local workspace.",
    "Return JSON only, with no markdown fences.",
    "Use only the workspace context below. Preserve unrelated content.",
    "Select the smallest relevant set of files. Existing files may be edited or deleted.",
    "Operations: create (new text file with complete proposedCode), edit (complete replacement), delete (empty proposedCode), rename (empty proposedCode plus fromPath), directory_create (empty proposedCode).",
    "For rename, path is the destination and fromPath is the existing source.",
    "Never touch authentication, secrets, credentials, environment files, keys, certificates, node_modules, or .git.",
    "Never include credentials, tokens, passwords, or private keys.",
    "Every operation must be physically applicable after approval. Do not claim anything was applied.",
    'JSON shape: {"summary":"...","explanation":"...","risk":"LOW|MEDIUM|HIGH","plan":["..."],"validationPlan":["..."],"files":[{"path":"...","fromPath":"optional rename source","operation":"create|edit|delete|rename|directory_create","proposedCode":"complete content or empty for non-content operations","explanation":"..."}]}',
    `REQUEST\n${request.trim().slice(0, 2_000)}`,
    `PREVIOUS VALIDATION ERRORS\n${previousErrors.slice(-5).join("\n") || "(none)"}`,
    `WORKSPACE CONTEXT\n${inspection.context}`,
  ].join("\n\n");
  let response;
  try {
    response = await provider.chat({ model, messages: [{ role: "system", content: prompt }, { role: "user", content: `Prepare the approval-gated proposal for: ${request.trim()}` }], temperature: 0.1 });
  } catch (error) {
    throw new ProposalError("service_unavailable", error instanceof Error ? error.message : "The AI provider could not prepare a local proposal.");
  }
  const parsed = parseProposal(response.content);
  const modelFiles = Array.isArray(parsed.files) ? parsed.files : [];
  if (!modelFiles.length || modelFiles.length > MAX_FILES) throw new ProposalError("malformed_model_response", "The model returned no usable local file operations.");
  const knownFiles = new Set(inspection.filesRead);
  const files: ChangeProposalFile[] = [];
  for (const item of modelFiles) {
    if (!item || typeof item !== "object") throw new ProposalError("malformed_model_response", "A local file operation was malformed.");
    const candidate = item as Record<string, unknown>;
    const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
    const operation = candidate.operation === "create" || candidate.operation === "edit" || candidate.operation === "delete" || candidate.operation === "rename" || candidate.operation === "directory_create"
      ? candidate.operation
      : undefined;
    const fromPath = typeof candidate.fromPath === "string" ? candidate.fromPath.trim() : undefined;
    const proposedCode = typeof candidate.proposedCode === "string" ? candidate.proposedCode : "";
    const explanation = typeof candidate.explanation === "string" && candidate.explanation.trim() ? candidate.explanation.trim() : "Focused change required by the request.";
    if (!path || !operation) throw new ProposalError("malformed_model_response", "Every local operation needs a path and supported operation.");
    const safePath = safeEditablePath(path);
    const safeFromPath = fromPath ? safeEditablePath(fromPath) : undefined;
    if ((operation === "edit" || operation === "delete") && !knownFiles.has(safePath)) throw new ProposalError("insufficient_context", `The model targeted an unread file: ${safePath}`);
    if (operation === "rename" && (!safeFromPath || !knownFiles.has(safeFromPath))) throw new ProposalError("insufficient_context", `The rename source was not read: ${safeFromPath ?? safePath}`);
    if (operation !== "rename" && safeFromPath) throw new ProposalError("invalid_patch", `Only rename operations may specify fromPath: ${safePath}`);
    if (SECRET_LIKE.test(proposedCode)) throw new ProposalError("protected_file", `The proposal contains credential-like content and was rejected: ${safePath}`);
    let originalCode = "";
    let exists = false;
    const source = operation === "rename" ? safeFromPath! : safePath;
    try {
      originalCode = (await readWorkspaceFile(userId, projectId, source)).content;
      exists = true;
    } catch {
      exists = false;
    }
    if ((operation === "create" || operation === "directory_create") && exists) throw new ProposalError("invalid_patch", `The new path already exists: ${safePath}`);
    if ((operation === "edit" || operation === "delete" || operation === "rename") && !exists) throw new ProposalError("file_not_found", `The source file was not found: ${source}`);
    if (operation === "rename") {
      try {
        await readWorkspaceFile(userId, projectId, safePath);
        throw new ProposalError("invalid_patch", `The rename destination already exists: ${safePath}`);
      } catch (error) {
        if (error instanceof ProposalError) throw error;
      }
    }
    if ((operation === "edit" || operation === "create") && originalCode === proposedCode) throw new ProposalError("invalid_patch", `The proposal does not change ${safePath}.`);
    const targetCode = operation === "edit" || operation === "create" ? proposedCode : "";
    const stats = operation === "delete" ? { addedLines: 0, removedLines: lineCount(originalCode) } : operation === "edit" || operation === "create" ? changeStats(originalCode, targetCode) : { addedLines: 0, removedLines: 0 };
    files.push({
      path: safePath,
      fromPath: safeFromPath,
      operation,
      language: operation === "directory_create" ? "directory" : languageFor(safePath),
      originalCode,
      proposedCode: targetCode,
      diff: localDiff(safePath, safeFromPath, originalCode, targetCode, operation),
      explanation,
      ...stats,
    });
  }
  const proposal: ChangeProposal = {
    proposalId: "",
    status: "proposal",
    summary: stringValue(parsed.summary, "Proposed local workspace change"),
    explanation: stringValue(parsed.explanation, "Review the bounded local diff before approval. Nothing has been written."),
    risk: parsed.risk === "HIGH" || parsed.risk === "MEDIUM" ? parsed.risk : "LOW",
    files,
    affectedFiles: [...new Set(files.flatMap((file) => file.fromPath ? [file.fromPath, file.path] : [file.path]))],
    addedLines: files.reduce((total, file) => total + file.addedLines, 0),
    removedLines: files.reduce((total, file) => total + file.removedLines, 0),
    plan: stringArray(parsed.plan, ["Inspect the workspace structure and relevant entry points.", "Apply only the approved file operations."]),
    validationPlan: stringArray(parsed.validationPlan, ["Run bounded local type and build checks.", "Confirm the final workspace matches the approved operations."]),
  };
  proposal.proposalId = workspaceProposalId(files, `${userId}:${projectId}`);
  return { proposal, inspection };
}

function safeEditablePath(value: string): string {
  const safe = safeWorkspaceRelative(value);
  if (PROTECTED_PATH.test(safe)) throw new ProposalError("protected_file", `Protected files cannot be changed: ${safe}`);
  return safe;
}

function parseProposal(content: string): ModelLocalProposal {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as ModelLocalProposal;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch {
    throw new ProposalError("malformed_model_response", "The local proposal response was not valid JSON.");
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  const values = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 300)).slice(0, 8) : [];
  return values.length ? values : fallback;
}

function languageFor(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return ({ ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact", mjs: "javascript", css: "css", html: "html", json: "json", md: "markdown" } as Record<string, string>)[extension ?? ""] ?? "text";
}

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

function changeStats(original: string, proposed: string): { addedLines: number; removedLines: number } {
  const oldLines = original.split("\n");
  const newLines = proposed.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  return { removedLines: oldLines.length - prefix - suffix, addedLines: newLines.length - prefix - suffix };
}

function localDiff(path: string, fromPath: string | undefined, original: string, proposed: string, operation: ChangeProposalFile["operation"]): string {
  if (operation === "rename") return `--- a/${fromPath}\n+++ b/${path}\n@@ rename @@\n`;
  if (operation === "directory_create") return `--- /dev/null\n+++ b/${path}/\n@@ directory create @@\n+`;
  const oldLines = original.split("\n");
  const newLines = proposed.split("\n");
  if (operation === "create") return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${newLines.length} @@`, ...newLines.map((line) => `+${line}`)].join("\n");
  if (operation === "delete") return [`--- a/${path}`, `+++ /dev/null`, `@@ delete @@`, ...oldLines.map((line) => `-${line}`)].join("\n");
  return [`--- a/${path}`, `+++ b/${path}`, "@@ change @@", ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join("\n");
}