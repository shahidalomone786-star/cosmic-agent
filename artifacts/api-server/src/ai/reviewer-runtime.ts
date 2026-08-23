import { z } from "@workspace/api-zod";
import { getAgentSession, type AgentSession } from "./agent-runtime";
import { conflictFindingSchema, dependencyFindingSchema, workerReportSchema, type WorkerReport } from "./worker-runtime";
import type { ToolCallTrace } from "./manager-brain";
import { verifyEvidenceForTrace } from "./evidence-verifier";

export const evidenceCheckSchema = z.object({
  claim: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(4_000),
  sourceToolCallId: z.string().min(1),
  critical: z.boolean().default(true),
  result: z.enum(["match", "mismatch", "insufficient"]).optional(),
});
export type EvidenceCheck = z.infer<typeof evidenceCheckSchema>;

export const reviewRequestSchema = z.object({
  taskId: z.string().min(1),
  proposalFiles: z.array(z.string().min(1)).max(50).default([]),
  groundedFindings: z.array(evidenceCheckSchema).max(50),
  dependencies: z.array(dependencyFindingSchema).max(30).default([]),
  conflicts: z.array(conflictFindingSchema).max(20).default([]),
  workerReports: z.array(workerReportSchema).max(10).default([]),
  notes: z.string().max(4_000).optional(),
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const reviewResultSchema = z.object({
  taskId: z.string(),
  verdict: z.enum(["approve", "request-changes", "reject"]),
  groundedFindings: z.array(evidenceCheckSchema),
  freeTextNotes: z.string().optional(),
  toolCallIds: z.array(z.string()),
  reviewerStatus: z.enum(["completed", "blocked", "failed"]),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export function reviewProposal(input: ReviewRequest): ReviewResult {
  const session = getAgentSession(input.taskId);
  if (!session) {
    return {
      taskId: input.taskId,
      verdict: "reject",
      groundedFindings: input.groundedFindings.map((finding) => ({ ...finding, result: "insufficient" as const })),
      toolCallIds: [],
      freeTextNotes: "The task session was not found; no evidence can be trusted.",
      reviewerStatus: "blocked",
    };
  }

  const findings = input.groundedFindings.map((finding) => verifyEvidence(session, finding));
  const reportChecks = input.workerReports.flatMap((report) => validateWorkerReportEvidence(session, report));
  const scopeViolation = input.proposalFiles.find((file) => !isInScope(session, file));
  const unresolvedConflict = input.conflicts.some((conflict) => conflict.status !== "resolved")
    || input.workerReports.some((report) => report.conflicts.some((conflict) => conflict.status !== "resolved"));
  const invalidDependency = input.dependencies.some((dependency) => dependency.status === "verified" && !hasCompletedTrace(session, dependency.evidenceToolCallId));
  const unrelatedChange = input.workerReports.some((report) =>
    report.proposals.some((proposal) => input.proposalFiles.length > 0 && !input.proposalFiles.includes(proposal.path)),
  );
  const criticalInsufficient = findings.some((finding) => finding.critical && finding.result === "insufficient")
    || reportChecks.some((check) => check === "insufficient");
  const criticalMismatch = findings.some((finding) => finding.critical && finding.result === "mismatch")
    || reportChecks.some((check) => check === "mismatch");

  let verdict: ReviewResult["verdict"] = "approve";
  if (scopeViolation || unresolvedConflict || invalidDependency || unrelatedChange || criticalInsufficient) verdict = "request-changes";
  if (criticalMismatch) verdict = "reject";

  const toolCallIds = [...new Set(findings.filter((finding) => finding.result !== "insufficient").map((finding) => finding.sourceToolCallId))];
  return {
    taskId: input.taskId,
    verdict,
    groundedFindings: findings,
    toolCallIds,
    freeTextNotes: [
      input.notes,
      scopeViolation ? `Proposal exceeds explicit file scope: ${scopeViolation}` : undefined,
      unresolvedConflict ? "Worker conflict remains unresolved and must be routed back to the manager." : undefined,
      invalidDependency ? "A dependency was marked verified without a completed server trace." : undefined,
      unrelatedChange ? "A worker proposed a file outside the final proposal file set." : undefined,
      reportChecks.length ? "One or more worker claims are not grounded in a completed trace for this task." : undefined,
    ].filter(Boolean).join(" ") || undefined,
    reviewerStatus: "completed",
  };
}

function validateWorkerReportEvidence(session: AgentSession, report: WorkerReport): Array<"insufficient" | "mismatch"> {
  const problems: Array<"insufficient" | "mismatch"> = [];
  if (report.taskId !== session.id || report.status === "failed") return ["insufficient"];
  for (const toolCallId of report.toolCallIds) {
    const trace = session.toolTraces.find((candidate) => candidate.toolCallId === toolCallId);
    if (!trace || trace.taskId !== session.id || !["frontend", "backend"].includes(trace.role) || !trace.completedAt) problems.push("insufficient");
  }
  for (const finding of report.findings) {
    if (!finding.evidenceToolCallId) {
      problems.push("insufficient");
      continue;
    }
    const trace = session.toolTraces.find((candidate) => candidate.toolCallId === finding.evidenceToolCallId);
    const verified = verifyEvidenceForTrace(trace, session.id, {
      claim: finding.title,
      evidence: finding.description,
      sourceToolCallId: finding.evidenceToolCallId,
      critical: true,
    }, report.role);
    if (verified.result === "insufficient" || verified.result === "mismatch") problems.push(verified.result);
  }
  if (report.validation.sourceToolCallId) {
    const trace = session.toolTraces.find((candidate) => candidate.toolCallId === report.validation.sourceToolCallId);
    if (!trace || trace.taskId !== session.id || trace.role !== report.role || trace.tool !== "run_typecheck" || !trace.completedAt) problems.push("insufficient");
  } else {
    problems.push("insufficient");
  }
  return problems;
}

function verifyEvidence(session: AgentSession, finding: EvidenceCheck): EvidenceCheck {
  const trace = session.toolTraces.find((candidate) => candidate.toolCallId === finding.sourceToolCallId);
  return verifyEvidenceForTrace(trace, session.id, finding);
}

function hasCompletedTrace(session: AgentSession, toolCallId?: string): boolean {
  return Boolean(toolCallId && session.toolTraces.some((trace) =>
    trace.toolCallId === toolCallId && trace.taskId === session.id && trace.status === "completed" && trace.completedAt,
  ));
}

function isInScope(session: AgentSession, path: string): boolean {
  const explicit = session.contextMemory.explicitFiles;
  return explicit.length === 0 || explicit.includes(path.replace(/^@/, "").trim());
}
