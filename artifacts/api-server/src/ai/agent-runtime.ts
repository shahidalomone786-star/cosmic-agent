import { createHash, randomUUID } from "node:crypto";
import { createChangeProposal, type ChangeProposal } from "./change-proposal";
import type { AiProvider } from "./ai-provider";
import { retrieveRepositoryContext, type RepositoryContextResult, type RepositoryRef, readRepositoryFile, searchRepository, getRepositoryOverview } from "../repository/github-provider";
import { registerProposal } from "../repository/patch-executor";
import { fitContext } from "./context-budget";
import { initializeManager, type AgentPlan, type ManagerDecision, type TaskClassification } from "./manager-brain";

export const MAX_AGENT_ITERATIONS = Math.max(1, Math.min(Number(process.env.COSMIC_MAX_AGENT_ITERATIONS ?? 6), 12));
export const MAX_SESSION_COUNT = 100;

export type AgentStep =
  | "understand"
  | "plan"
  | "retrieve_context"
  | "act"
  | "observe"
  | "verify"
  | "complete";
export type AgentSessionStatus = "running" | "waiting_approval" | "completed" | "failed";

export type AgentEvent = {
  id: string;
  type:
    | "task_started"
    | "planning"
    | "context_retrieval"
    | "tool_called"
    | "proposal_generated"
    | "approval_requested"
    | "validation_started"
    | "task_completed"
    | "task_failed"
    | "retry";
  label: string;
  detail?: string;
  timestamp: string;
};

export type AgentPlanStep = {
  id: AgentStep;
  title: string;
  status: "pending" | "active" | "complete" | "blocked";
};

export type AgentSession = {
  id: string;
  task: string;
  status: AgentSessionStatus;
  currentStep: AgentStep;
  iteration: number;
  maxIterations: number;
  plan: AgentPlanStep[];
  repository?: RepositoryRef;
  selectedFiles: string[];
  discoveredFiles: string[];
  selectedTools: string[];
  activeModel: string;
  provider: string;
  classification: TaskClassification;
  managerPlan: AgentPlan;
  managerDecision: ManagerDecision;
  managerReplanCount: number;
  context: {
    filesIncluded: number;
    approximateChars: number;
    chunked: boolean;
    warnings: string[];
    offloadedResultId?: string;
  };
  toolResults: Array<{ tool: string; status: "complete" | "failed"; summary: string; input?: Record<string, string | number>; output?: Record<string, unknown> }>;
  memory: {
    completedTools: string[];
    validationResults: string[];
    contextNotes: string[];
  };
  recovery?: { code: string; message: string; newProposalRequired: boolean };
  proposal?: { proposalId: string; files: string[]; risk: string; summary: string };
  proposalData?: ChangeProposal;
  events: AgentEvent[];
  createdAt: string;
  updatedAt: string;
};

export type AgentRunInput = {
  task: string;
  model: string;
  repository?: RepositoryRef;
  paths?: string[];
};

export type AgentToolDefinition = {
  name: string;
  permission: "read" | "proposal" | "approval_required";
  schema: Record<string, string>;
  outputLimit: number;
  timeoutMs: number;
};

const sessions = new Map<string, AgentSession>();
const offloadedResults = new Map<string, { sessionId: string; preview: string; content: string }>();
const proposalSessions = new Map<string, string>();
let sessionSequence = 0;

const now = () => new Date().toISOString();
const uniquePaths = (paths: string[] = []) =>
  [...new Set(paths.map((path) => path.replace(/^@/, "").trim()).filter(Boolean))].slice(0, 20);
const addEvent = (session: AgentSession, type: AgentEvent["type"], label: string, detail?: string) => {
  session.events.push({ id: `event-${sessionSequence++}`, type, label, detail, timestamp: now() });
  session.updatedAt = now();
};
const plan = (): AgentPlanStep[] => [
  { id: "understand", title: "Understand the task", status: "pending" },
  { id: "plan", title: "Build a bounded plan", status: "pending" },
  { id: "retrieve_context", title: "Retrieve relevant context", status: "pending" },
  { id: "act", title: "Prepare a safe proposal", status: "active" },
  { id: "observe", title: "Observe proposal results", status: "pending" },
  { id: "verify", title: "Validate after approval", status: "pending" },
  { id: "complete", title: "Complete with human approval", status: "pending" },
];

function compactText(value: string, limit: number): string {
  const seen = new Set<string>();
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join("\n")
    .slice(0, limit);
}

function offload(sessionId: string, content: string): string | undefined {
  if (content.length <= 18_000) return undefined;
  const id = `result-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  offloadedResults.set(id, { sessionId, preview: content.slice(0, 900), content });
  return id;
}

function unavailableContext(): RepositoryContextResult {
  return {
    text: "Repository evidence is unavailable. Do not infer repository facts; ask the user to retry later.",
    sources: [],
    warnings: ["Repository evidence is unavailable; no source context was sent."],
    approximateChars: 0,
    chunked: false,
  };
}

function updateStep(session: AgentSession, step: AgentStep, status: AgentPlanStep["status"]): void {
  session.currentStep = step;
  session.plan = session.plan.map((item) => item.id === step ? { ...item, status } : item);
  session.updatedAt = now();
}

function completeStep(session: AgentSession, step: AgentStep): void {
  session.plan = session.plan.map((item) => item.id === step ? { ...item, status: "complete" } : item);
}

const toolDefinitions: readonly AgentToolDefinition[] = [
  { name: "repository_search", permission: "read", schema: { repository: "RepositoryRef", query: "string" }, outputLimit: 4_000, timeoutMs: 12_000 },
  { name: "read_file", permission: "read", schema: { repository: "RepositoryRef", path: "string" }, outputLimit: 12_000, timeoutMs: 12_000 },
  { name: "file_context", permission: "read", schema: { repository: "RepositoryRef", paths: "string[]" }, outputLimit: 18_000, timeoutMs: 20_000 },
  { name: "analyze_repository", permission: "read", schema: { repository: "RepositoryRef" }, outputLimit: 8_000, timeoutMs: 20_000 },
  { name: "create_proposal", permission: "proposal", schema: { repository: "RepositoryRef", paths: "string[]", request: "string" }, outputLimit: 16_000, timeoutMs: 45_000 },
  { name: "apply_approved_patch", permission: "approval_required", schema: { proposalId: "string" }, outputLimit: 4_000, timeoutMs: 60_000 },
  { name: "run_typecheck", permission: "approval_required", schema: { proposalId: "string" }, outputLimit: 4_000, timeoutMs: 60_000 },
  { name: "run_build", permission: "approval_required", schema: { proposalId: "string" }, outputLimit: 4_000, timeoutMs: 60_000 },
  { name: "inspect_validation_result", permission: "read", schema: { proposalId: "string" }, outputLimit: 4_000, timeoutMs: 5_000 },
  { name: "repository_status", permission: "read", schema: { repository: "RepositoryRef" }, outputLimit: 2_000, timeoutMs: 5_000 },
];

export class AgentToolError extends Error {
  constructor(readonly code: "unknown_tool" | "approval_required" | "invalid_input" | "timeout" | "bounded", message: string) {
    super(message);
  }
}

export async function executeAgentTool(
  provider: AiProvider,
  session: AgentSession,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const definition = toolDefinitions.find((tool) => tool.name === name);
  if (!definition) throw new AgentToolError("unknown_tool", `Tool is not registered: ${name}`);
  const normalizedInput = JSON.stringify(input);
  if (session.toolResults.some((result) => result.tool === name && JSON.stringify(result.input) === normalizedInput)) {
    throw new AgentToolError("bounded", `${name} was already completed with the same input during this session.`);
  }
  if (definition.permission === "approval_required") {
    addEvent(session, "approval_requested", "Approval gate held", `${name} cannot run until the matching human approval flow is completed.`);
    throw new AgentToolError("approval_required", `${name} requires explicit human approval.`);
  }
  const repository = input.repository as RepositoryRef | undefined;
  if (name === "inspect_validation_result") {
    return { proposalId: typeof input.proposalId === "string" ? input.proposalId : "", status: "approval_required", summary: "Validation results are only available after an approved patch execution." };
  }
  if (!repository) throw new AgentToolError("invalid_input", `${name} requires a repository.`);
  const run = <T>(operation: Promise<T>): Promise<T> => withTimeout(operation, definition.timeoutMs, `${name} timed out.`);
  let result: unknown;
  if (name === "repository_search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query || query.length > 240) throw new AgentToolError("invalid_input", "repository_search requires a query up to 240 characters.");
    result = await run(searchRepository(repository, query));
  }
  if (name === "read_file") {
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path || path.length > 500) throw new AgentToolError("invalid_input", "read_file requires a valid path.");
    result = await run(readRepositoryFile(repository, path));
  }
  if (name === "file_context") {
    const paths = Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === "string") : [];
       const budget = fitContext([{ key: "task", text: session.task, relevance: 100, explicit: true }], session.context.approximateChars > 32_000 ? 32_000 : 64_000);
       result = await run(retrieveRepositoryContext(repository, uniquePaths(paths), budget.text, session.context.approximateChars > 32_000 ? 32_000 : 64_000));
  }
  if (name === "analyze_repository") result = await run(getRepositoryOverview(repository));
  if (name === "repository_status") result = { repository: `${repository.owner}/${repository.name}`, branch: repository.branch, mode: "read_only", writes: "approval_required" };
  if (name === "create_proposal") {
    const paths = Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === "string") : [];
    result = await run(createChangeProposal(provider, session.activeModel, session.task, repository, uniquePaths(paths)));
  }
  if (result === undefined) throw new AgentToolError("unknown_tool", `Tool is not registered: ${name}`);
  const compacted = compactResult(result, definition.outputLimit);
  session.toolResults.push({ tool: name, status: "complete", summary: "Completed with bounded output.", input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "repository" && key !== "content").slice(0, 8).map(([key, value]) => [key, typeof value === "string" || typeof value === "number" ? value : JSON.stringify(value).slice(0, 240)])), output: compacted && typeof compacted === "object" ? { keys: Object.keys(compacted as object).slice(0, 12) } : undefined });
  session.memory.completedTools = [...new Set([...session.memory.completedTools, name])].slice(-30);
  if (session.toolResults.length > 30) session.toolResults = session.toolResults.slice(-30);
  return compacted;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([operation, new Promise<T>((_, reject) => setTimeout(() => reject(new AgentToolError("timeout", message)), timeoutMs))]);
}

function compactResult(value: unknown, limit: number): unknown {
  if (typeof value === "string") return value.slice(0, limit);
  if (Array.isArray(value)) return value.slice(0, 20);
  if (!value || typeof value !== "object") return value;
  const record = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(record)) if (typeof record[key] === "string") record[key] = (record[key] as string).slice(0, Math.max(500, Math.floor(limit / 2)));
  return record;
}

export async function runAgentSession(provider: AiProvider, input: AgentRunInput): Promise<AgentSession> {
  const task = input.task.trim();
  if (!task) throw new Error("Describe the task you want the agent to plan.");
  if (sessions.size >= MAX_SESSION_COUNT) sessions.delete(sessions.keys().next().value);

  const manager = initializeManager(randomUUID(), task, input.model, provider.getModels());
  const session: AgentSession = {
    id: randomUUID(),
    task: task.slice(0, 2_000),
    status: "running",
    currentStep: "understand",
    iteration: 0,
    maxIterations: MAX_AGENT_ITERATIONS,
    plan: plan(),
    repository: input.repository,
    selectedFiles: uniquePaths(input.paths),
    discoveredFiles: [],
    selectedTools: selectTools(task, Boolean(input.repository)),
    activeModel: input.model,
    provider: provider.id,
    classification: manager.classification,
    managerPlan: manager.managerPlan,
    managerDecision: manager.decision,
    managerReplanCount: manager.replanCount,
    context: { filesIncluded: 0, approximateChars: 0, chunked: false, warnings: [] },
    toolResults: [],
    memory: { completedTools: [], validationResults: [], contextNotes: [] },
    events: [],
    createdAt: now(),
    updatedAt: now(),
  };
  sessions.set(session.id, session);
  addEvent(session, "task_started", "Task started", "Bounded runtime initialized.");
  updateStep(session, "understand", "active");
  addEvent(session, "tool_called", "Runtime inspected task", "The task is limited to the approved agent workflow.");
  completeStep(session, "understand");
  updateStep(session, "plan", "active");
  addEvent(session, "planning", "Plan created", `${MAX_AGENT_ITERATIONS} iteration limit; approval gates remain active.`);
  completeStep(session, "plan");
  updateStep(session, "retrieve_context", "active");
  addEvent(session, "context_retrieval", "Retrieving relevant context", session.selectedFiles.length ? `${session.selectedFiles.length} explicitly selected file(s) prioritized.` : "No explicit files selected.");

  let context = unavailableContext();
  if (session.repository) {
    try {
      addEvent(session, "tool_called", "Calling file_context", "Read-only repository context retrieval.");
      context = await executeAgentTool(provider, session, "file_context", { repository: session.repository, paths: session.selectedFiles }) as RepositoryContextResult;
      session.toolResults.push({ tool: "file_context", status: "complete", summary: `${context.sources.length} relevant source(s) retrieved.`, output: { sources: context.sources.slice(0, 8).map((source) => source.path), approximateChars: context.approximateChars } });
      session.discoveredFiles = context.sources.map((source) => source.path);
      session.memory.completedTools.push("file_context");
      session.memory.contextNotes.push(...context.warnings);
    } catch {
      session.toolResults.push({ tool: "context.retrieve", status: "failed", summary: "Repository retrieval failed safely; no source facts were inferred." });
    }
  } else {
    session.toolResults.push({ tool: "file_context", status: "complete", summary: "Skipped repository retrieval because no repository is connected." });
  }
  session.context = {
    filesIncluded: context.sources.length,
    approximateChars: context.approximateChars,
    chunked: context.chunked,
    warnings: context.warnings,
    offloadedResultId: offload(session.id, compactText(context.text, 64_000)),
  };

  completeStep(session, "retrieve_context");
  updateStep(session, "act", "active");
  if (session.repository && session.selectedFiles.length) {
    try {
      addEvent(session, "tool_called", "Calling create_proposal", "Proposal-only generation; no repository write is permitted.");
      const proposal = await executeAgentTool(provider, session, "create_proposal", { repository: session.repository, paths: session.selectedFiles, request: session.task }) as ChangeProposal;
      registerProposal(proposal, session.repository);
      session.proposal = {
        proposalId: proposal.proposalId,
        files: proposal.files.map((file) => file.path),
        risk: proposal.risk,
        summary: proposal.summary,
      };
      session.proposalData = proposal;
      proposalSessions.set(proposal.proposalId, session.id);
      session.status = "waiting_approval";
      session.currentStep = "observe";
       session.plan = session.plan.map((step) =>
        step.id === "act" ? { ...step, status: "complete" } :
        step.id === "observe" ? { ...step, status: "active" } :
        step.id === "verify" || step.id === "complete" ? { ...step, status: "blocked" } : step,
      );
      addEvent(session, "proposal_generated", "Safe proposal generated", `${proposal.files.length} file(s), ${proposal.risk.toLowerCase()} risk.`);
      addEvent(session, "approval_requested", "Human approval required", "The proposal must be reviewed before any write or validation operation.");
    } catch (error) {
      session.status = "failed";
      session.currentStep = "complete";
      session.plan = session.plan.map((step) => step.id === "act" ? { ...step, status: "blocked" } : step);
      addEvent(session, "task_failed", "Proposal generation failed", error instanceof Error ? error.message : "The proposal could not be generated.");
      session.toolResults.push({ tool: "create_proposal", status: "failed", summary: "No changes were written." });
    }
  } else {
    session.status = "completed";
    session.currentStep = "complete";
    session.plan = session.plan.map((step) => ({ ...step, status: step.id === "complete" ? "complete" : "complete" }));
    addEvent(session, "task_completed", "Planning complete", "Connect a repository and select files to generate an approval-gated proposal.");
  }
  session.iteration = 1;
  session.updatedAt = now();
  return session;
}

export function getAgentSession(id: string): AgentSession | undefined {
  return sessions.get(id);
}

export function getOffloadedResult(sessionId: string, resultId: string): { preview: string; content: string } | undefined {
  const result = offloadedResults.get(resultId);
  return result?.sessionId === sessionId ? { preview: result.preview, content: result.content } : undefined;
}

export function getAgentToolDefinitions() {
  return toolDefinitions;
}

export async function requestAgentTool(
  provider: AiProvider,
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const session = sessions.get(sessionId);
  if (!session) throw new AgentToolError("invalid_input", "Agent session not found.");
  if (session.iteration >= session.maxIterations) throw new AgentToolError("bounded", "The session iteration limit has been reached.");
  session.iteration += 1;
  addEvent(session, "tool_called", `Tool requested: ${name}`, "Server permission and schema validation applied.");
  try {
    const result = await executeAgentTool(provider, session, name, input);
    return result;
  } catch (error) {
    session.toolResults.push({ tool: name, status: "failed", summary: error instanceof Error ? error.message : "Tool failed safely." });
    throw error;
  }
}

export function recordAgentValidation(proposalId: string, result: { status: string; message: string }): AgentSession | undefined {
  const sessionId = proposalSessions.get(proposalId);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) return undefined;
  session.memory.validationResults = [...session.memory.validationResults, `${result.status}: ${result.message}`].slice(-10);
  if (result.status === "validation_failed") {
    session.recovery = { code: "validation_failure", message: "Validation failed safely. A new proposal is required; no automatic fix was applied.", newProposalRequired: true };
    session.status = "waiting_approval";
    session.currentStep = "act";
    session.plan = session.plan.map((step) => step.id === "act" ? { ...step, status: "active" } : step);
    addEvent(session, "retry", "Validation failed safely", "Generate a new proposal and request approval again.");
  }
  session.updatedAt = now();
  return session;
}

function selectTools(task: string, hasRepository: boolean): string[] {
  if (!hasRepository) return ["repository_status"];
  const tools = ["repository_status", "analyze_repository", "file_context", "create_proposal"];
  if (/\b(search|find|where|locate|auth|route|redirect|error)\b/i.test(task)) tools.splice(1, 0, "repository_search");
  return tools;
}