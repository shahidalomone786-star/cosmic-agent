import type { AgentEvent, AgentSession } from "../ai/agent-runtime";
import type { ChangeProposal } from "../ai/change-proposal";

export type LocalAgentSession = AgentSession & { proposalData?: ChangeProposal };
type LocalSessionRecord = { ownerId: string; projectId: string; session: LocalAgentSession };

const sessions = new Map<string, LocalSessionRecord>();

export function registerLocalSession(proposalId: string, ownerId: string, projectId: string, session: LocalAgentSession): void {
  sessions.set(proposalId, { ownerId, projectId, session });
}

export function getLocalSession(proposalId: string, ownerId?: string, projectId?: string): LocalAgentSession | undefined {
  const record = sessions.get(proposalId);
  if (!record || (ownerId && record.ownerId !== ownerId) || (projectId && record.projectId !== projectId)) return undefined;
  return record.session;
}

export function recordLocalLifecycle(
  proposalId: string,
  phase: "applying" | "validating" | "preview_starting" | "preview_ready" | "preview_failed",
  detail: string,
): LocalAgentSession | undefined {
  const session = sessions.get(proposalId)?.session;
  if (!session) return undefined;
  const timestamp = new Date().toISOString();
  const lifecycle: Record<typeof phase, { type: AgentEvent["type"]; label: string }> = {
    applying: { type: "applying", label: "Applying" },
    validating: { type: "validation_started", label: "Validating" },
    preview_starting: { type: "preview_started", label: "Starting Preview" },
    preview_ready: { type: "preview_ready", label: "Preview Ready" },
    preview_failed: { type: "preview_failed", label: "Preview failed" },
  };
  const event = lifecycle[phase];
  session.events.push({ id: `local-event-${phase}-${proposalId}-${Date.now()}`, type: event.type, label: event.label, detail, timestamp });
  if (phase === "applying") {
    session.status = "running";
    session.currentState = "APPLYING";
    session.currentStep = "verify";
    session.plan = session.plan.map((step) => step.id === "verify" ? { ...step, status: "active" } : step);
  } else if (phase === "validating") {
    session.status = "running";
    session.currentState = "VALIDATING";
    session.currentStep = "verify";
  } else if (phase === "preview_failed") {
    session.status = "failed";
    session.currentState = "FAILED";
    session.recovery = { code: "preview_failure", message: "The approved application could not start. Fix the runtime and restart Preview.", newProposalRequired: false };
  } else if (phase === "preview_ready") {
    session.status = "completed";
    session.currentState = "COMPLETED";
    session.currentStep = "complete";
    session.plan = session.plan.map((step) => ({ ...step, status: "complete" }));
  }
  session.updatedAt = timestamp;
  return session;
}

export function recordLocalValidation(proposalId: string, passed: boolean, detail: string): LocalAgentSession | undefined {
  const session = sessions.get(proposalId)?.session;
  if (!session) return undefined;
  const timestamp = new Date().toISOString();
  session.events.push({
    id: `local-event-validation-${proposalId}-${Date.now()}`,
    type: passed ? "task_completed" : "retry",
    label: passed ? "Validation passed" : "Validation failed safely",
    detail,
    timestamp,
  });
  if (passed) {
    session.status = "completed";
    session.currentState = "COMPLETED";
    session.currentStep = "complete";
    session.plan = session.plan.map((step) => ({ ...step, status: "complete" }));
  } else {
    session.status = "waiting_approval";
    session.currentState = "WAITING_FOR_APPROVAL";
    session.currentStep = "act";
    session.plan = session.plan.map((step) => step.id === "act" ? { ...step, status: "active" } : step);
    session.recovery = { code: "validation_failure", message: "Validation failed safely. A new proposal is required.", newProposalRequired: true };
  }
  session.memory.validationResults = [...session.memory.validationResults, `${passed ? "pass" : "fail"}: ${detail}`].slice(-10);
  session.updatedAt = timestamp;
  return session;
}