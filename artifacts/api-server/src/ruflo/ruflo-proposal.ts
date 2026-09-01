import type { AiProvider } from "../ai/ai-provider";
import { createChangeProposal, ProposalError, type ChangeProposal } from "../ai/change-proposal";
import { createLocalProposal } from "../workspace/local-proposal";
import { ensureWorkspace, safeWorkspaceRelative } from "../workspace/local-workspace";
import { registerProposal } from "../repository/patch-executor";
import type { RepositoryRef } from "../repository/github-provider";
import type { RufloSession, RufloWorkspaceRef } from "./ruflo-runtime";

const binaryExtension = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|mp[34-9]|exe|dll|so|dylib)$/i;

export type RufloProposalInput = {
  provider: AiProvider;
  model: string;
  session: RufloSession;
  ownerId?: string;
  repository?: RepositoryRef;
  workspace?: RufloWorkspaceRef;
};

export async function createRufloProposal(input: RufloProposalInput): Promise<ChangeProposal> {
  const paths = filterTextProposalPaths(input.session.selectedFiles);
  if (input.session.selectedFiles.length > 0 && paths.length === 0) {
    throw new ProposalError(
      "binary_file",
      "Binary assets can be safely referenced, but they cannot be sent into text proposal editing.",
    );
  }

  let proposal: ChangeProposal;
  if (input.repository) {
    proposal = await createChangeProposal(
      input.provider,
      input.model,
      input.session.task,
      input.repository,
      paths,
    );
    reviewRufloProposal(proposal, paths);
    registerProposal(proposal, input.repository, input.provider.id, undefined, input.ownerId, undefined, input.session.id);
    return proposal;
  }

  if (input.workspace) {
    const root = await ensureWorkspace(input.workspace.userId, input.workspace.projectId);
    const result = await createLocalProposal(
      input.provider,
      input.model,
      input.workspace.userId,
      input.workspace.projectId,
      input.session.task,
      paths,
    );
    proposal = result.proposal;
    reviewRufloProposal(proposal, paths);
    registerProposal(
      proposal,
      undefined,
      undefined,
      root,
      input.workspace.userId,
      input.workspace.projectId,
      input.session.id,
    );
    return proposal;
  }

  throw new ProposalError("insufficient_context", "A connected repository or workspace is required before proposal generation.");
}

export function filterTextProposalPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((value) => value.replace(/^@/, "").replaceAll("\\", "/").trim()).filter(Boolean))]
    .filter((value) => !binaryExtension.test(value))
    .slice(0, 20);
}

export function reviewRufloProposal(proposal: ChangeProposal, boundedPaths: readonly string[]): void {
  if (!proposal.files.length) {
    throw new ProposalError("invalid_patch", "The Ruflo reviewer found no applicable file operations.");
  }

  const bounded = new Set(boundedPaths);
  for (const file of proposal.files) {
    if (binaryExtension.test(file.path) || (file.fromPath && binaryExtension.test(file.fromPath))) {
      throw new ProposalError(
        "binary_file",
        `Binary assets may be referenced but cannot be edited in a text proposal: ${file.path}`,
      );
    }

    try {
      safeWorkspaceRelative(file.path);
      if (file.fromPath) safeWorkspaceRelative(file.fromPath);
    } catch {
      throw new ProposalError("protected_file", `The Ruflo reviewer rejected an unsafe proposal path: ${file.path}`);
    }

    const sourcePath = file.fromPath ?? file.path;
    const isNewTarget = file.operation === "create" || file.operation === "directory_create";
    if (!isNewTarget && bounded.size > 0 && !bounded.has(sourcePath) && !bounded.has(file.path)) {
      throw new ProposalError(
        "insufficient_context",
        `The Ruflo reviewer rejected a file outside the bounded inspection scope: ${file.path}`,
      );
    }
  }
}