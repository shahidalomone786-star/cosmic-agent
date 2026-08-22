import { createHash, randomUUID } from "node:crypto";
import { createChangeProposal, type ChangeProposal } from "./change-proposal";
import type { AiProvider } from "./ai-provider";
import { retrieveRepositoryContext, type RepositoryContextResult, type RepositoryRef, readRepositoryFile, searchRepository } from "../repository/github-provider";
import { registerProposal } from "../repository/patch-executor";

export const MAX_AGENT_ITERATIONS = 6;
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
  activeModel: string;
  provider: string;
  context: {
    filesIncluded: number;
    approximateChars: number;
    chunked: boolean;
    warnings: string[];
    offloadedResultId?: string;
  };
  toolResults: Array<{ tool: string; status: "complete" | "failed"; summary: string }>;
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
};

const sessions = new Map<string, AgentSession>();
const offloadedResults = new Map<string, { sessionId: string; preview: string; content: string }>();
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
  { name: "repository.search", permission: "read", schema: { repository: "RepositoryRef", query: "string" } },
  { name: "repository.read_file", permission: "read", schema: { repository: "RepositoryRef", path: "string" } },
  { name: "context.retrieve", permission: "read", schema: { repository: "RepositoryRef", paths: "string[]" } },
  { name: "proposal.generate", permission: "proposal", schema: { repository: "RepositoryRef", paths: "string[]", request: "string" } },
  { name: "proposal.execute", permission: "approval_required", schema: { proposalId: "string" } },
  { name: "validation.run", permission: "approval_required", schema: { proposalId: "string" } },
  { name: "github.write", permission: "approval_required", schema: { operation: "commit|push" } },
];

export class AgentToolError extends Error {
  constructor(readonly code: "unknown_tool" | "approval_required" | "invalid_input", message: string) {
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
  if (definition.permission === "approval_required") {
    addEvent(session, "approval_requested", "Approval gate held", `${name} cannot run until the matching human approval flow is completed.`);
    throw new AgentToolError("approval_required", `${name} requires explicit human approval.`);
  }
  const repository = input.repository as RepositoryRef | undefined;
  if (!repository) throw new AgentToolError("invalid_input", `${name} requires a repository.`);
  if (name === "repository.search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new AgentToolError("invalid_input", "repository.search requires a query.");
    return searchRepository(repository, query);
  }
  if (name === "repository.read_file") {
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path) throw new AgentToolError("invalid_input", "repository.read_file requires a path.");
    return readRepositoryFile(repository, path);
  }
  if (name === "context.retrieve") {
    const paths = Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === "string") : [];
    return retrieveRepositoryContext(repository, uniquePaths(paths), session.task);
  }
  if (name === "proposal.generate") {
    const paths = Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === "string") : [];
    return createChangeProposal(provider, session.activeModel, session.task, repository, uniquePaths(paths));
  }
  throw new AgentToolError("unknown_tool", `Tool is not registered: ${name}`);
}

export async function runAgentSession(provider: AiProvider, input: AgentRunInput): Promise<AgentSession> {
  const task = input.task.trim();
  if (!task) throw new Error("Describe the task you want the agent to plan.");
  if (sessions.size >= MAX_SESSION_COUNT) sessions.delete(sessions.keys().next().value);

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
    activeModel: input.model,
    provider: provider.id,
    context: { filesIncluded: 0, approximateChars: 0, chunked: false, warnings: [] },
    toolResults: [],
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
      addEvent(session, "tool_called", "Calling context.retrieve", "Read-only repository context retrieval.");
      context = await executeAgentTool(provider, session, "context.retrieve", { repository: session.repository, paths: session.selectedFiles }) as RepositoryContextResult;
      session.toolResults.push({ tool: "context.retrieve", status: "complete", summary: `${context.sources.length} relevant source(s) retrieved.` });
    } catch {
      session.toolResults.push({ tool: "context.retrieve", status: "failed", summary: "Repository retrieval failed safely; no source facts were inferred." });
    }
  } else {
    session.toolResults.push({ tool: "context.retrieve", status: "complete", summary: "Skipped repository retrieval because no repository is connected." });
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
      addEvent(session, "tool_called", "Calling proposal.generate", "Proposal-only generation; no repository write is permitted.");
      const proposal = await executeAgentTool(provider, session, "proposal.generate", { repository: session.repository, paths: session.selectedFiles, request: session.task }) as ChangeProposal;
      registerProposal(proposal, session.repository);
      session.proposal = {
        proposalId: proposal.proposalId,
        files: proposal.files.map((file) => file.path),
        risk: proposal.risk,
        summary: proposal.summary,
      };
      session.proposalData = proposal;
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
      session.toolResults.push({ tool: "proposal.generate", status: "failed", summary: "No changes were written." });
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