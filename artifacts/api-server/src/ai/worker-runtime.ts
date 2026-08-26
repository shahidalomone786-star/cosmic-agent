import { z } from "@workspace/api-zod";
import type { AiProvider } from "./ai-provider";
import {
  executeAgentTool,
  getAgentSession,
  type AgentSession,
} from "./agent-runtime";
import type { ToolCallTrace } from "./manager-brain";

export const workerRoleSchema = z.enum(["frontend", "backend", "reviewer", "validator"]);
export type WorkerRole = z.infer<typeof workerRoleSchema>;

export const WORKER_CONTRACTS = {
  frontend: {
    specialties: ["React/components", "UI structure", "CSS/styling", "responsive behavior", "frontend state", "routing", "client-side API usage", "accessibility", "existing design system"],
    tools: ["repository_search", "read_file", "file_context", "analyze_repository", "repository_status", "create_proposal", "run_typecheck"],
  },
  backend: {
    specialties: ["API routes", "server logic", "data flow", "server validation", "database interactions", "authentication integration", "provider integrations", "error handling"],
    tools: ["repository_search", "read_file", "file_context", "analyze_repository", "repository_status", "create_proposal", "run_typecheck"],
  },
  reviewer: {
    specialties: ["requirements coverage", "scope review", "dependency verification", "conflict resolution", "security review", "evidence grounding"],
    tools: ["repository_search", "read_file", "file_context", "analyze_repository", "repository_status", "run_typecheck"],
  },
  validator: {
    specialties: ["deterministic typecheck", "deterministic build", "execution result inspection", "validation evidence"],
    tools: ["repository_search", "read_file", "file_context", "analyze_repository", "repository_status", "run_typecheck", "run_build", "inspect_validation_result"],
  },
} as const;

export const dependencyFindingSchema = z.object({
  description: z.string().min(1).max(2_000),
  fromRole: workerRoleSchema,
  toRole: workerRoleSchema,
  status: z.enum(["reported", "verified", "conflict"]).default("reported"),
  evidenceToolCallId: z.string().uuid().optional(),
});
export type DependencyFinding = z.infer<typeof dependencyFindingSchema>;

export const conflictFindingSchema = z.object({
  claim: z.string().min(1).max(2_000),
  parties: z.array(workerRoleSchema).min(2).max(3),
  status: z.enum(["unresolved", "resolved"]).default("unresolved"),
  resolution: z.string().max(2_000).optional(),
});
export type ConflictFinding = z.infer<typeof conflictFindingSchema>;

export const validationClaimSchema = z.object({
  status: z.enum(["pass", "fail", "not-verified"]),
  sourceToolCallId: z.string().min(1).optional(),
  summary: z.string().min(1).max(2_000),
});
export type ValidationClaim = z.infer<typeof validationClaimSchema>;

export const fileProposalSchema = z.object({
  path: z.string().min(1).max(500),
  diff: z.string().min(1).max(100_000),
  rationale: z.string().min(1).max(2_000),
  risk: z.enum(["low", "medium", "high"]),
  addedLines: z.number().int().min(0),
  removedLines: z.number().int().min(0),
});
export type FileProposal = z.infer<typeof fileProposalSchema>;

export const workerFindingSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(4_000),
  file: z.string().max(500).optional(),
  evidenceToolCallId: z.string().min(1).optional(),
});
export type WorkerFinding = z.infer<typeof workerFindingSchema>;

export const workerReportSchema = z.object({
  role: workerRoleSchema,
  taskId: z.string().min(1),
  subtaskId: z.string().min(1),
  filesInspected: z.array(z.string().min(1)).max(50),
  relevantFiles: z.array(z.string().min(1)).max(50),
  findings: z.array(workerFindingSchema).max(50),
  proposals: z.array(fileProposalSchema).max(10),
  dependencies: z.array(z.string().min(1)).max(30),
  dependencyFindings: z.array(dependencyFindingSchema).max(30).default([]),
  conflicts: z.array(conflictFindingSchema).max(20).default([]),
  validation: validationClaimSchema,
  toolCallIds: z.array(z.string().uuid()).max(50),
  tokensUsed: z.number().int().min(0).optional(),
  status: z.enum(["completed", "blocked", "failed"]),
});
export type WorkerReport = z.infer<typeof workerReportSchema>;

export const workerToolRequestSchema = z.object({
  role: workerRoleSchema,
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
});

export type WorkerContext = {
  role: WorkerRole;
  taskId: string;
  task: string;
  explicitFiles: string[];
  assignedFiles: string[];
  relevantFiles: string[];
  contextMemory: AgentSession["contextMemory"];
  priorToolCallIds: string[];
  memory: {
    assignedTask: string;
    assignedSubtask: string;
    relevantFiles: string[];
    completedToolIds: string[];
    findings: string[];
    dependencies: string[];
    validationResults: string[];
  };
};

export function getWorkerContext(sessionId: string, role: WorkerRole, assignedFiles: string[] = []): WorkerContext | undefined {
  const session = getAgentSession(sessionId);
  if (!session) return undefined;
  const explicit = session.contextMemory.explicitFiles;
  const discovered = session.contextMemory.relevantFiles.length ? session.contextMemory.relevantFiles : session.discoveredFiles;
  const assignedSubtask = session.managerPlan.steps.find((step) => step.assignedRole === role)?.description
    ?? `Contribute the ${role} work for the requested task.`;
  const state = {
    relevantFiles: session.workerState.relevantFiles[role] ?? [],
    completedToolIds: session.workerState.completedToolIds[role] ?? [],
    findings: session.workerState.findings[role] ?? [],
    dependencies: session.workerState.dependencies[role] ?? [],
    validationResults: session.workerState.validationResults[role] ?? [],
  };
  return {
    role,
    taskId: session.id,
    task: session.task,
    explicitFiles: explicit,
    assignedFiles: unique(assignedFiles),
    relevantFiles: unique([...explicit, ...assignedFiles, ...discovered]).slice(0, 50),
    contextMemory: session.contextMemory,
    priorToolCallIds: session.toolTraces.filter((trace) => trace.role === role).map((trace) => trace.toolCallId),
    memory: {
      assignedTask: session.task.slice(0, 500),
      assignedSubtask: assignedSubtask.slice(0, 1_000),
      relevantFiles: unique([...state.relevantFiles, ...explicit, ...assignedFiles, ...discovered]).slice(0, 50),
      completedToolIds: state.completedToolIds.slice(-20),
      findings: state.findings.slice(-20),
      dependencies: state.dependencies.slice(-20),
      validationResults: state.validationResults.slice(-10),
    },
  };
}

export async function executeWorkerTool(
  provider: AiProvider,
  sessionId: string,
  role: WorkerRole,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const session = getAgentSession(sessionId);
  if (!session) throw new Error("Agent session not found.");
  if (session.iteration >= session.maxIterations) throw new Error("The session iteration limit has been reached.");
  const key = `${role}:${name}:${JSON.stringify(input).slice(0, 2_000)}`;
  const attempts = session.workerState.retryCounts[key] ?? 0;
  const maxAttempts = 2;
  let lastError: unknown;
  for (let attempt = attempts; attempt < maxAttempts; attempt += 1) {
    session.workerState.retryCounts[key] = attempt + 1;
    session.iteration += 1;
    try {
      const result = await executeAgentTool(provider, session, name, input, role);
      const trace = session.toolTraces.at(-1);
      if (trace) session.workerState.completedToolIds[role] = [...new Set([...(session.workerState.completedToolIds[role] ?? []), trace.toolCallId])].slice(-20);
      return result;
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/timeout|temporar|provider|rate/i.test(error.message) || attempt + 1 >= maxAttempts) break;
    }
  }
  session.status = "failed";
  session.currentState = "FAILED";
  session.recovery = { code: "worker_failure", message: "Worker retries were exhausted; the task was preserved without applying changes.", newProposalRequired: false };
  throw lastError instanceof Error ? lastError : new Error("Worker execution failed after bounded retries.");
}

export function validateWorkerReport(reportInput: unknown): { report: WorkerReport; validation: ValidationClaim } {
  const report = workerReportSchema.parse(reportInput);
  const session = getAgentSession(report.taskId);
  if (!session) return { report, validation: forceNotVerified(report.validation, "The task session was not found.") };
  if (report.role === "reviewer" || report.role === "validator") {
    return { report, validation: forceNotVerified(report.validation, "Only frontend and backend workers may submit worker reports.") };
  }
  if (report.status === "failed") return { report, validation: forceNotVerified(report.validation, "A failed worker cannot make a trusted validation claim.") };

  const scopeViolation = report.proposals.find((proposal) => !isInAssignedScope(session, proposal.path));
  if (scopeViolation) {
    return { report, validation: forceNotVerified(report.validation, `Proposal path is outside the assigned scope: ${scopeViolation.path}`) };
  }

  const trace = findValidationTrace(session, report);
  if (!trace) {
    rememberWorkerReport(session, report);
    return { report, validation: forceNotVerified(report.validation, "No completed run_typecheck evidence belongs to this worker.") };
  }

  const actual = trace.status === "completed" ? "pass" : trace.status === "failed" ? "fail" : "not-verified";
  if (actual !== report.validation.status) {
    return { report, validation: forceNotVerified(report.validation, "The validation claim does not match the server execution trace.") };
  }
  rememberWorkerReport(session, report);
  return { report, validation: { ...report.validation, sourceToolCallId: trace.toolCallId, status: actual } };
}

function rememberWorkerReport(session: AgentSession, report: WorkerReport): void {
  const role = report.role;
  session.workerState.assignedTasks[role] = session.task.slice(0, 500);
  session.workerState.assignedSubtasks[role] = report.subtaskId;
  session.workerState.relevantFiles[role] = unique(report.relevantFiles).slice(0, 50);
  session.workerState.findings[role] = report.findings.map((finding) => finding.title).slice(-20);
  session.workerState.dependencies[role] = report.dependencies.slice(-20);
  session.workerState.validationResults[role] = [...(session.workerState.validationResults[role] ?? []), report.validation.status].slice(-10);
}

export function isInAssignedScope(session: AgentSession, path: string): boolean {
  const normalized = path.replace(/^@/, "").trim();
  const explicit = session.contextMemory.explicitFiles;
  return explicit.length === 0 || explicit.includes(normalized);
}

function findValidationTrace(session: AgentSession, report: WorkerReport): ToolCallTrace | undefined {
  const sourceId = report.validation.sourceToolCallId;
  if (!sourceId || !report.toolCallIds.includes(sourceId)) return undefined;
  const trace = session.toolTraces.find((candidate) =>
    candidate.toolCallId === sourceId &&
    candidate.taskId === report.taskId &&
    candidate.role === report.role &&
    candidate.tool === "run_typecheck" &&
    Boolean(candidate.completedAt),
  );
  return trace;
}

function forceNotVerified(claim: ValidationClaim, summary: string): ValidationClaim {
  return { status: "not-verified", sourceToolCallId: claim.sourceToolCallId, summary };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/^@/, "").trim()).filter(Boolean))];
}