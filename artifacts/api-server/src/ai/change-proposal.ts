import { createHash } from "node:crypto";
import { readRepositoryFile, retrieveRepositoryContext, RepositoryError, type RepositoryRef } from "../repository/github-provider";
import type { AiChatMessage, AiProvider } from "./ai-provider";

export type ProposalRisk = "LOW" | "MEDIUM" | "HIGH";

export type ChangeProposalFile = {
  path: string;
  language: string;
  originalCode: string;
  proposedCode: string;
  diff: string;
  explanation: string;
  addedLines: number;
  removedLines: number;
};

export type ChangeProposal = {
  status: "proposal";
  summary: string;
  explanation: string;
  risk: ProposalRisk;
  files: ChangeProposalFile[];
  affectedFiles: string[];
  addedLines: number;
  removedLines: number;
};

type ModelProposal = {
  summary?: unknown;
  explanation?: unknown;
  risk?: unknown;
  files?: unknown;
};

export class ProposalError extends Error {
  constructor(
    readonly code:
      | "insufficient_context"
      | "malformed_model_response"
      | "invalid_patch"
      | "protected_file"
      | "file_not_found"
      | "binary_file"
      | "too_large"
      | "rate_limited"
      | "permission_denied"
      | "service_unavailable",
    message: string,
  ) {
    super(message);
  }
}

const PROTECTED_PATH = /(^|\/)(\.env(?:\..*)?|\.git|node_modules|credentials?|secrets?)(\/|$)|(^|\/).*?\.(pem|key|p12|pfx|crt)$/i;
const PROTECTED_AUTH_FILE = /(^|\/)(authStore|AuthContext)\.(ts|tsx|js|jsx)$/;
const SECRET_LIKE = /(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"']{8,})/i;
const MAX_PROPOSAL_FILES = 6;
const MAX_SOURCE_CHARS = 72_000;

export async function createChangeProposal(
  provider: AiProvider,
  model: string,
  request: string,
  repository: RepositoryRef,
  paths: string[],
): Promise<ChangeProposal> {
  if (!request.trim()) throw new ProposalError("invalid_patch", "Describe the change you want to preview.");

  let context;
  try {
    context = await retrieveRepositoryContext(repository, paths, request);
  } catch (error) {
    throw mapRepositoryError(error);
  }

  const explicitPaths = [...new Set(paths.map((path) => path.replace(/^@/, "").trim()).filter(Boolean))].slice(0, MAX_PROPOSAL_FILES);
  const allowedPaths = [...new Set([...explicitPaths, ...context.sources.map((source) => source.path)])];
  if (!allowedPaths.length || !context.text.trim()) {
    throw new ProposalError("insufficient_context", "Select one or more readable source files before generating a change proposal.");
  }

  const sourceFiles = [];
  for (const path of allowedPaths) {
    assertEditablePath(path);
    try {
      const file = await readRepositoryFile(repository, path);
      if (file.content.includes("\u0000")) throw new ProposalError("binary_file", `Binary file edits are not supported: ${path}`);
      sourceFiles.push(file);
    } catch (error) {
      throw mapRepositoryError(error, path);
    }
  }
  if (!sourceFiles.length) throw new ProposalError("insufficient_context", "No readable source files were available for this proposal.");

  const boundedSource = sourceFiles.reduce((text, file) => {
    if (text.length >= MAX_SOURCE_CHARS) return text;
    return `${text}\n\n### FILE: ${file.path}\n${file.content.slice(0, MAX_SOURCE_CHARS - text.length)}`;
  }, "");
  const messages: AiChatMessage[] = [
    {
      role: "system",
      content: [
        "You are a proposal-only coding assistant.",
        "Return JSON only. Do not use markdown fences.",
        "You may propose changes only to files listed in the source context.",
        "Return the complete proposed file content in proposedCode; never return a partial snippet.",
        "Do not modify authentication files named authStore.ts or AuthContext.tsx, secrets, credentials, environment files, keys, certificates, node_modules, or .git paths.",
        "Do not add credentials, tokens, passwords, or private keys.",
        "Do not claim the change was applied. This is only a review preview.",
        'JSON shape: {"summary":"...","explanation":"...","risk":"LOW|MEDIUM|HIGH","files":[{"path":"...","proposedCode":"...","explanation":"..."}]}',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Repository: ${repository.owner}/${repository.name} (${repository.branch})`,
        `Requested change: ${request.trim()}`,
        `Allowed files: ${allowedPaths.join(", ")}`,
        "Indexed context:",
        context.text,
        "Exact source files:",
        boundedSource,
      ].join("\n\n"),
    },
  ];

  let modelResponse;
  try {
    modelResponse = await provider.chat({ model, messages, temperature: 0.1 });
  } catch (error) {
    throw mapProviderError(error);
  }

  const parsed = parseModelProposal(modelResponse.content);
  const proposalFiles = Array.isArray(parsed.files) ? parsed.files : [];
  if (!proposalFiles.length || proposalFiles.length > MAX_PROPOSAL_FILES) {
    throw new ProposalError("malformed_model_response", "The model returned no usable file proposals.");
  }

  const files: ChangeProposalFile[] = [];
  for (const item of proposalFiles) {
    if (!item || typeof item !== "object") throw new ProposalError("malformed_model_response", "The model returned a malformed file proposal.");
    const candidate = item as Record<string, unknown>;
    const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
    const proposedCode = typeof candidate.proposedCode === "string" ? candidate.proposedCode : "";
    const explanation = typeof candidate.explanation === "string" ? candidate.explanation : "Proposed change from the selected repository context.";
    if (!path || !proposedCode) throw new ProposalError("malformed_model_response", "Every proposed file needs a path and complete proposedCode.");
    assertEditablePath(path);
    if (!allowedPaths.includes(path)) throw new ProposalError("insufficient_context", `The proposal targets a file outside the selected context: ${path}`);
    const original = sourceFiles.find((file) => file.path === path);
    if (!original) throw new ProposalError("file_not_found", `The proposed file was not available in the retrieved context: ${path}`);
    if (SECRET_LIKE.test(proposedCode)) throw new ProposalError("protected_file", `The proposal contains credential-like content and was rejected: ${path}`);
    if (proposedCode === original.content) throw new ProposalError("invalid_patch", `The proposal does not change ${path}.`);
    const diff = unifiedDiff(path, original.content, proposedCode);
    const stats = diffStats(original.content, proposedCode);
    files.push({ path, language: original.language, originalCode: original.content, proposedCode, diff, explanation, ...stats });
  }

  if (!files.length) throw new ProposalError("invalid_patch", "The model did not produce an applicable change.");
  const risk = parsed.risk === "HIGH" || parsed.risk === "MEDIUM" ? parsed.risk : "LOW";
  return {
    status: "proposal",
    summary: typeof parsed.summary === "string" ? parsed.summary : "Proposed repository change",
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "Review the proposed diff before any future execution step.",
    risk,
    files,
    affectedFiles: files.map((file) => file.path),
    addedLines: files.reduce((count, file) => count + file.addedLines, 0),
    removedLines: files.reduce((count, file) => count + file.removedLines, 0),
  };
}

function assertEditablePath(path: string): void {
  if (PROTECTED_PATH.test(path) || PROTECTED_AUTH_FILE.test(path)) {
    throw new ProposalError("protected_file", `Protected files cannot be changed in proposal mode: ${path}`);
  }
}

function parseModelProposal(content: string): ModelProposal {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as ModelProposal;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch {
    throw new ProposalError("malformed_model_response", "The model response was not valid proposal JSON.");
  }
}

function diffStats(original: string, proposed: string): { addedLines: number; removedLines: number } {
  const originalLines = original.split("\n");
  const proposedLines = proposed.split("\n");
  let prefix = 0;
  while (prefix < originalLines.length && prefix < proposedLines.length && originalLines[prefix] === proposedLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < originalLines.length - prefix && suffix < proposedLines.length - prefix && originalLines[originalLines.length - suffix - 1] === proposedLines[proposedLines.length - suffix - 1]) suffix++;
  return {
    removedLines: originalLines.length - prefix - suffix,
    addedLines: proposedLines.length - prefix - suffix,
  };
}

function unifiedDiff(path: string, original: string, proposed: string): string {
  const originalLines = original.split("\n");
  const proposedLines = proposed.split("\n");
  const stats = diffStats(original, proposed);
  let prefix = 0;
  while (prefix < originalLines.length && prefix < proposedLines.length && originalLines[prefix] === proposedLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < originalLines.length - prefix && suffix < proposedLines.length - prefix && originalLines[originalLines.length - suffix - 1] === proposedLines[proposedLines.length - suffix - 1]) suffix++;
  const start = Math.max(0, prefix - 3);
  const originalEnd = Math.min(originalLines.length, originalLines.length - suffix + 3);
  const proposedEnd = Math.min(proposedLines.length, proposedLines.length - suffix + 3);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start + 1},${Math.max(0, originalEnd - start)} +${start + 1},${Math.max(0, proposedEnd - start)} @@`,
    ...originalLines.slice(start, prefix).map((line) => ` ${line}`),
    ...originalLines.slice(prefix, originalLines.length - suffix).map((line) => `-${line}`),
    ...proposedLines.slice(prefix, proposedLines.length - suffix).map((line) => `+${line}`),
    ...originalLines.slice(originalLines.length - suffix, originalEnd).map((line) => ` ${line}`),
  ];
  if (!stats.addedLines && !stats.removedLines) throw new ProposalError("invalid_patch", `No diff could be generated for ${path}.`);
  return lines.join("\n");
}

function mapRepositoryError(error: unknown, path?: string): ProposalError {
  if (error instanceof ProposalError) return error;
  if (error instanceof RepositoryError) {
    if (error.code === "rate_limited") return new ProposalError("rate_limited", error.message);
    if (error.code === "permission_denied") return new ProposalError("permission_denied", error.message);
    if (error.code === "file_not_found") return new ProposalError("file_not_found", path ? `File not found: ${path}` : error.message);
    if (error.code === "unsupported_binary") return new ProposalError("binary_file", error.message);
    if (error.code === "too_large") return new ProposalError("too_large", error.message);
    return new ProposalError("service_unavailable", error.message);
  }
  return new ProposalError("service_unavailable", "Repository source retrieval failed. Please retry.");
}

function mapProviderError(error: unknown): ProposalError {
  const message = error instanceof Error ? error.message : "The AI provider failed to generate a proposal.";
  if (/rate limit/i.test(message)) return new ProposalError("rate_limited", message);
  if (/configured|unavailable|timed out/i.test(message)) return new ProposalError("service_unavailable", message);
  return new ProposalError("service_unavailable", message);
}

export function proposalId(proposal: ChangeProposal): string {
  return createHash("sha256").update(proposal.files.map((file) => file.diff).join("\n")).digest("hex").slice(0, 12);
}