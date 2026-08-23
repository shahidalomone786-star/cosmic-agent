import { z } from "@workspace/api-zod";
import type { AiProvider } from "./ai-provider";
import {
  executeAgentTool,
  getAgentSession,
  type AgentSession,
} from "./agent-runtime";
import type { ToolCallTrace } from "./manager-brain";

export const workerRoleSchema = z.enum(["frontend", "backend"]);
export type WorkerRole = z.infer<typeof workerRoleSchema>;

export const WORKER_CONTRACTS = {
  frontend: {
    specialties: ["React/components", "UI structure", "CSS/styling", "responsive behavior", "frontend state", "routing", "client-side API usage", "accessibility", "existing design system"],
    tools: ["repository_search", "read_file", "file_context", "analyze_repository", "repository_status", "run_typecheck"],
  },
  backend: {
    specialties: ["API routes", "server logic", "data flow", "server validation", "database interactions", "authentication integration", "provider integrations", "error handling"],
    tools: ["repository_search", "read_file", "file_context", "analyze_repository", "repository_status", "run_typecheck"],
  },
} as const;

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
};

export function getWorkerContext(sessionId: string, role: WorkerRole, assignedFiles: string[] = []): WorkerContext | undefined {
  const session = getAgentSession(sessionId);
  if (!session) return undefined;
  const explicit = session.contextMemory.explicitFiles;
  const discovered = session.contextMemory.relevantFiles.length ? session.contextMemory.relevantFiles : session.discoveredFiles;
  return {
    role,
    taskId: session.id,
    task: session.task,
    explicitFiles: explicit,
    assignedFiles: unique(assignedFiles),
    relevantFiles: unique([...explicit, ...assignedFiles, ...discovered]).slice(0, 50),
    contextMemory: session.contextMemory,
    priorToolCallIds: session.toolTraces.filter((trace) => trace.role === role).map((trace) => trace.toolCallId),
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
  session.iteration += 1;
  return executeAgentTool(provider, session, name, input, role);
}

export function validateWorkerReport(reportInput: unknown): { report: WorkerReport; validation: ValidationClaim } {
  const report = workerReportSchema.parse(reportInput);
  const session = getAgentSession(report.taskId);
  if (!session) return { report, validation: forceNotVerified(report.validation, "The task session was not found.") };

  const trace = findValidationTrace(session, report);
  if (!trace) return { report, validation: forceNotVerified(report.validation, "No completed run_typecheck evidence belongs to this worker.") };

  const actual = trace.status === "completed" ? "pass" : trace.status === "failed" ? "fail" : "not-verified";
  if (actual !== report.validation.status) {
    return { report, validation: forceNotVerified(report.validation, "The validation claim does not match the server execution trace.") };
  }
  return { report, validation: { ...report.validation, sourceToolCallId: trace.toolCallId, status: actual } };
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