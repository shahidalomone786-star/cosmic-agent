import { createHash, randomUUID } from "node:crypto";
import type { ChangeProposal } from "./change-proposal";
import type { RepositoryRef } from "../repository/github-provider";
import { z } from "@workspace/api-zod";

export const approvalRequestSchema = z.object({
  proposalId: z.string().min(1),
  action: z.enum(["apply", "commit", "push"]).default("apply"),
});

export type ApprovalAction = "apply" | "commit" | "push";
export type ProposalApproval = {
  approvalId: string;
  taskId?: string;
  proposalId: string;
  proposalVersion: string;
  repositorySha: string;
  fileHashes: Record<string, string>;
  approvedAt: string;
  approvedByUser: string;
  action: ApprovalAction;
};

export class ApprovalGateError extends Error {
  constructor(readonly code: "unauthenticated" | "invalid_approval" | "stale_proposal", message: string) {
    super(message);
  }
}

const approvals = new Map<string, ProposalApproval>();

export function proposalVersion(proposal: ChangeProposal): string {
  return createHash("sha256")
    .update(proposal.files.map((file) => `${file.path}\0${file.originalCode}\0${file.proposedCode}`).join("\n"))
    .digest("hex");
}

export function repositorySha(repository: RepositoryRef | undefined, proposal: ChangeProposal): string {
  return createHash("sha256")
    .update(`${repository?.owner ?? ""}/${repository?.name ?? ""}@${repository?.branch ?? ""}\n${proposal.files.map((file) => `${file.path}:${hash(file.originalCode)}`).join("\n")}`)
    .digest("hex");
}

export function approveProposal(
  proposal: ChangeProposal,
  repository: RepositoryRef | undefined,
  approvedByUser: string,
  taskId?: string,
  action: ApprovalAction = "apply",
): ProposalApproval {
  const user = approvedByUser.trim();
  if (!user) throw new ApprovalGateError("unauthenticated", "An authenticated user is required to approve changes.");
  const approval: ProposalApproval = {
    approvalId: randomUUID(),
    taskId,
    proposalId: proposal.proposalId,
    proposalVersion: proposalVersion(proposal),
    repositorySha: repositorySha(repository, proposal),
    fileHashes: Object.fromEntries(proposal.files.map((file) => [file.path, hash(file.originalCode)])),
    approvedAt: new Date().toISOString(),
    approvedByUser: user.slice(0, 200),
    action,
  };
  approvals.set(approval.approvalId, approval);
  return approval;
}

export function assertApproval(
  approvalId: string,
  proposal: ChangeProposal,
  repository: RepositoryRef | undefined,
  taskId?: string,
  action: ApprovalAction = "apply",
): ProposalApproval {
  const approval = approvals.get(approvalId);
  if (!approval || approval.action !== action || approval.proposalId !== proposal.proposalId || (approval.taskId && taskId && approval.taskId !== taskId)) {
    throw new ApprovalGateError("invalid_approval", "This approval does not authorize the requested proposal.");
  }
  if (
    approval.proposalVersion !== proposalVersion(proposal) ||
    approval.repositorySha !== repositorySha(repository, proposal) ||
    JSON.stringify(approval.fileHashes) !== JSON.stringify(Object.fromEntries(proposal.files.map((file) => [file.path, hash(file.originalCode)])))
  ) {
    throw new ApprovalGateError("stale_proposal", "The approved proposal is stale. A new proposal and approval are required.");
  }
  return approval;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
