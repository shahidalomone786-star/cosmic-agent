import { randomUUID } from "node:crypto";
import type { AiProvider } from "../ai/ai-provider";
import {
  getRepositoryOverview,
  readRepositoryFile,
  searchRepository,
  type RepositoryOverview,
  type RepositoryRef,
} from "../repository/github-provider";
import {
  inspectWorkspace,
  readWorkspaceFile,
  searchWorkspace,
} from "../workspace/local-workspace";
import {
  ModelRufloPlanner,
  type RufloAction,
  type RufloDecision,
  type RufloPlan,
  type RufloPlanner,
  type RufloPlannerInput,
  type RufloPlannerObservation,
} from "./ruflo-planner";
import type { RufloAgentExecution, RufloAgentLimits } from "./ruflo-agents";
import {
  RufloBudgetLimitError,
  RufloCostTracker,
  type RufloBudgetLimits,
  type RufloCostTotals,
} from "./ruflo-cost-tracker";
import type { RufloCapabilityClass } from "./ruflo-provider-router";
import { createDefaultRufloToolRegistry, type RufloToolRegistry } from "./ruflo-tool-registry";

export const DEFAULT_RUFLO_LIMITS = {
  maxIterations: 8,
  maxToolCalls: 12,
  maxRuntimeMs: 45_000,
  maxRetries: 1,
  maxAgentsPerSession: 5,
  maxTotalIterations: 10,
} as const;

export type RufloLimits = {
  maxIterations: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
  maxRetries: number;
  maxAgentsPerSession: number;
  maxTotalIterations: number;
};

export type RufloWorkspaceRef = {
  userId: string;
  projectId: string;
};

export type RufloToolName = "inspect_repository" | "search_repository" | "read_file";

export type RufloToolRequest = {
  name: RufloToolName;
  input: {
    query?: string;
    path?: string;
  };
  repository?: RepositoryRef;
  workspace?: RufloWorkspaceRef;
  task: string;
};

export type RufloToolResult = {
  name: RufloToolName;
  summary: string;
  data: unknown;
  files?: string[];
};

export interface RufloToolExecutor {
  execute(request: RufloToolRequest): Promise<RufloToolResult>;
}

export type RufloObservation = RufloPlannerObservation & {
  id: string;
  toolCallId?: string;
};

export type RufloEvent = {
  id: string;
  type:
    | "planned"
    | "decision"
    | "tool_started"
    | "tool_completed"
    | "retry"
    | "tool_failed"
    | "proposal_ready"
    | "limit_reached"
    | "failed";
  message: string;
  iteration: number;
  timestamp: string;
};

export type RufloRunStatus = "running" | "proposal_ready" | "failed" | "limit_reached";

export type RufloRuntimeError = {
  code:
    | "empty_task"
    | "empty_context"
    | "planner_failure"
    | "tool_failure"
    | "iteration_limit"
    | "tool_call_limit"
    | "runtime_limit"
    | "budget_limit";
  message: string;
  cause?: string;
};

export type RufloSession = {
  id: string;
  task: string;
  status: RufloRunStatus;
  plan: RufloPlan;
  iteration: number;
  toolCalls: number;
  retries: number;
  selectedFiles: string[];
  discoveredFiles: string[];
  context: string;
  observations: RufloObservation[];
  events: RufloEvent[];
  currentAction?: RufloAction;
  proposalReady: boolean;
  error?: RufloRuntimeError;
  providerAttempts: string[];
  agentExecutions: RufloAgentExecution<unknown>[];
  agentLimits: RufloAgentLimits;
  createdAt: string;
  updatedAt: string;
  capability?: RufloCapabilityClass;
  budget?: RufloBudgetLimits;
  usage?: RufloCostTotals;
};

export type RufloRunInput = {
  sessionId?: string;
  task: string;
  model: string;
  provider: AiProvider;
  fallbackProviders?: AiProvider[];
  capability?: RufloCapabilityClass;
  budget?: Partial<RufloBudgetLimits>;
  costTracker?: RufloCostTracker;
  repository?: RepositoryRef;
  workspace?: RufloWorkspaceRef;
  selectedFiles?: string[];
  memoryContext?: string;
  planner?: RufloPlanner;
  tools?: RufloToolExecutor;
  limits?: Partial<RufloLimits>;
  now?: () => number;
  onUpdate?: (session: RufloSession) => void;
};

export class RufloRuntimeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RufloRuntimeInputError";
  }
}

class RufloRuntimeDeadlineError extends Error {
  constructor() {
    super("The Ruflo runtime limit was reached during a bounded operation.");
    this.name = "RufloRuntimeDeadlineError";
  }
}

/**
 * Run one Ruflo session to the proposal-ready boundary.
 *
 * The planner can suggest actions, but this runtime remains the authority that
 * decides whether an action is allowed and the tool executor remains the
 * authority that touches repository/workspace data.
 */
export async function runRufloSession(input: RufloRunInput): Promise<RufloSession> {
  const task = input.task.trim();
  if (!task) throw new RufloRuntimeInputError("Describe the task you want Ruflo to inspect.");

  const limits = normalizeLimits(input.limits);
  const nowMs = input.now ?? Date.now;
  const startedAt = nowMs();
  const session = createSession(task, input, limits);
  const planner = input.planner ?? new ModelRufloPlanner();
  const tools = input.tools ?? createRufloToolExecutor();
  const providers = uniqueProviders([input.provider, ...(input.fallbackProviders ?? [])]);
  const publish = () => {
    if (input.costTracker) session.usage = input.costTracker.getSessionTotals(session.id);
    try {
      input.onUpdate?.(session);
    } catch {
      // Observers must never affect the bounded runtime.
    }
  };
  publish();

  const elapsed = () => Math.max(0, nowMs() - startedAt);
  const stopForLimit = (code: RufloRuntimeError["code"], message: string): RufloSession => {
    session.status = code === "runtime_limit" || code === "iteration_limit" || code === "tool_call_limit" || code === "budget_limit"
      ? "limit_reached"
      : "failed";
    session.error = { code, message };
    addEvent(session, code === "runtime_limit" || code === "iteration_limit" || code === "tool_call_limit" ? "limit_reached" : "failed", message, nowMs);
    const finished = finishSession(session, nowMs);
    publish();
    return finished;
  };
  const withinRuntime = (message: string): RufloSession | undefined => elapsed() >= limits.maxRuntimeMs
    ? stopForLimit("runtime_limit", message)
    : undefined;

  try {
    const plan = await runPlannerWithFailover(
      providers,
      limits,
      session,
      nowMs,
      (provider) => withRuntimeBudget(
        planner.createPlan(plannerInput(input, provider, session)),
        elapsed,
        limits.maxRuntimeMs,
      ),
      "plan",
    );
    session.plan = plan;
    addEvent(session, "planned", `Created a bounded plan with ${plan.steps.length} step(s).`, nowMs);
    publish();
  } catch (error) {
    if (error instanceof RufloRuntimeDeadlineError) {
      return stopForLimit("runtime_limit", error.message);
    }
      if (error instanceof RufloBudgetLimitError) {
        return stopForLimit("budget_limit", error.message);
      }
    return failSession(session, "planner_failure", error, nowMs);
  }

  while (true) {
    const runtimeLimit = withinRuntime("The Ruflo runtime limit was reached before the next bounded action.");
    if (runtimeLimit) return runtimeLimit;
    if (session.iteration >= limits.maxIterations) {
      return stopForLimit("iteration_limit", `The Ruflo iteration limit of ${limits.maxIterations} was reached.`);
    }

    session.iteration += 1;
    let decision: RufloDecision;
    try {
      decision = await runPlannerWithFailover(
        providers,
        limits,
        session,
        nowMs,
        (provider) => withRuntimeBudget(
          planner.decide({
            ...plannerInput(input, provider, session),
            plan: session.plan,
            observations: session.observations,
            iteration: session.iteration,
          }),
          elapsed,
          limits.maxRuntimeMs,
        ),
        "decision",
      );
    } catch (error) {
      if (error instanceof RufloRuntimeDeadlineError) {
        return stopForLimit("runtime_limit", error.message);
      }
      if (error instanceof RufloBudgetLimitError) {
        return stopForLimit("budget_limit", error.message);
      }
      return failSession(session, "planner_failure", error, nowMs, publish);
    }

    const safeDecision = enforceDecision(decision, session);
    session.currentAction = safeDecision.action;
    addEvent(session, "decision", `${safeDecision.action}: ${safeDecision.reasoning}`, nowMs);
    publish();

    if (safeDecision.action === "prepare_proposal") {
      if (!session.context.trim() || session.discoveredFiles.length === 0) {
        return failSession(
          session,
          "empty_context",
          new Error("Ruflo cannot become proposal-ready without readable repository or workspace evidence."),
          nowMs,
          publish,
        );
      }
      session.status = "proposal_ready";
      session.proposalReady = true;
      addEvent(session, "proposal_ready", "Bounded inspection is complete; the session is ready for proposal generation.", nowMs);
      const finished = finishSession(session, nowMs);
      publish();
      return finished;
    }

    if (session.toolCalls >= limits.maxToolCalls) {
      return stopForLimit(`tool_call_limit`, `The Ruflo tool-call limit of ${limits.maxToolCalls} was reached.`);
    }

    const request = buildToolRequest(safeDecision, input, session);
    session.toolCalls += 1;
    const toolCallId = randomUUID();
    addEvent(session, "tool_started", `Executing bounded ${request.name}.`, nowMs);
    publish();

    try {
      const result = await runToolWithRetry(
        tools,
        request,
        limits,
        session,
        nowMs,
        elapsed,
      );
      const observation = observeToolResult(session, result, toolCallId);
      addEvent(session, "tool_completed", observation.summary, nowMs);
      if (result.name === "inspect_repository" && (!result.files || result.files.length === 0)) {
        return failSession(
          session,
          "empty_context",
          new Error("Ruflo inspection found no readable repository or workspace files."),
          nowMs,
        );
      }
      if (result.files?.length) {
        session.discoveredFiles = uniquePaths([...session.discoveredFiles, ...result.files]);
      }
      if (result.name === "inspect_repository") {
        const selected = result.files ?? [];
        session.selectedFiles = uniquePaths([...session.selectedFiles, ...selected]);
      }
      continue;
    } catch (error) {
      const observation: RufloObservation = {
        id: randomUUID(),
        toolCallId,
        iteration: session.iteration,
        tool: request.name,
        status: "failed",
        summary: "Bounded tool execution failed.",
        error: errorMessage(error),
      };
      session.observations.push(observation);
      addEvent(session, "tool_failed", `${request.name} failed: ${observation.error}`, nowMs);
      publish();
      if (error instanceof RufloRuntimeDeadlineError) {
        return stopForLimit("runtime_limit", error.message);
      }
      return failSession(session, "tool_failure", error, nowMs, publish);
    }
  }
}

export function createRufloToolExecutor(registry: RufloToolRegistry = createDefaultRufloToolRegistry()): RufloToolExecutor {
  return {
    async execute(request): Promise<RufloToolResult> {
      if (!request.repository && !request.workspace) {
        throw new RufloRuntimeInputError("A connected repository or workspace is required for Ruflo inspection.");
      }
      registry.authorize(request.name, request.input, {
        permissions: ["repository:read", "workspace:read"],
        allowLowRisk: false,
        approved: false,
      });

      if (request.name === "inspect_repository") {
        if (request.repository) {
          const overview = await getRepositoryOverview(request.repository);
          const files = selectRepositoryFiles(request.task, overview, request.input.path ? [request.input.path] : []);
          return {
            name: request.name,
            summary: `Inspected ${overview.fileCount} indexed file(s) and selected ${files.length} relevant file(s).`,
            data: compactOverview(overview, files),
            files,
          };
        }
        const inspection = await inspectWorkspace(
          request.workspace!.userId,
          request.workspace!.projectId,
          [],
          request.task,
        );
        return {
          name: request.name,
          summary: `Inspected the workspace and selected ${inspection.relevantFiles.length} relevant file(s).`,
          data: {
            structure: inspection.structure.slice(0, 120),
            entryPoints: inspection.entryPoints.slice(0, 20),
            context: inspection.context.slice(0, 16_000),
          },
          files: inspection.relevantFiles.slice(0, 20),
        };
      }

      if (request.name === "read_file") {
        const path = cleanPath(request.input.path);
        if (!path) throw new RufloRuntimeInputError("read_file requires a bounded file path.");
        if (request.repository) {
          const file = await readRepositoryFile(request.repository, path);
          return {
            name: request.name,
            summary: `Read ${file.path} (${file.size} bytes${file.truncated ? ", truncated" : ""}).`,
            data: { ...file, content: file.content.slice(0, 12_000) },
            files: [file.path],
          };
        }
        const file = await readWorkspaceFile(request.workspace!.userId, request.workspace!.projectId, path);
        return {
          name: request.name,
          summary: `Read ${file.path} (${file.size} bytes).`,
          data: { ...file, content: file.content.slice(0, 12_000) },
          files: [file.path],
        };
      }

      const query = typeof request.input.query === "string" ? request.input.query.trim().slice(0, 240) : "";
      if (!query) throw new RufloRuntimeInputError("search_repository requires a bounded search query.");
      const results = request.repository
        ? await searchRepository(request.repository, query)
        : await searchWorkspace(request.workspace!.userId, request.workspace!.projectId, query);
      return {
        name: request.name,
        summary: `Search returned ${results.length} bounded result(s) for "${query}".`,
        data: results.slice(0, 40),
        files: uniquePaths(results.map((result) => result.path)),
      };
    },
  };
}

function createSession(task: string, input: RufloRunInput, limits: RufloLimits): RufloSession {
  const timestamp = new Date().toISOString();
  return {
    id: input.sessionId ?? randomUUID(),
    task: task.slice(0, 2_000),
    status: "running",
    plan: { goal: task.slice(0, 2_000), steps: [] },
    iteration: 0,
    toolCalls: 0,
    retries: 0,
    selectedFiles: uniquePaths(input.selectedFiles ?? []),
    discoveredFiles: [],
    context: "",
    observations: [],
    events: [],
    proposalReady: false,
    providerAttempts: [],
    agentExecutions: [],
    agentLimits: {
      maxAgentsPerSession: limits.maxAgentsPerSession,
      maxRetries: limits.maxRetries,
      maxTotalIterations: limits.maxTotalIterations,
    },
    capability: input.capability,
    budget: input.budget ? { ...input.budget } as RufloBudgetLimits : undefined,
    usage: input.costTracker?.getSessionTotals(input.sessionId ?? ""),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function plannerInput(input: RufloRunInput, provider: AiProvider, session: RufloSession): RufloPlannerInput {
  return {
    provider,
    model: input.model,
    task: session.task,
    repository: input.repository,
    workspace: input.workspace,
    selectedFiles: session.selectedFiles,
    context: session.context,
    memoryContext: input.memoryContext,
  };
}

function normalizeLimits(input: Partial<RufloLimits> | undefined): RufloLimits {
  const value = input ?? {};
  return {
    maxIterations: positiveLimit(value.maxIterations, DEFAULT_RUFLO_LIMITS.maxIterations, 1, 32),
    maxToolCalls: positiveLimit(value.maxToolCalls, DEFAULT_RUFLO_LIMITS.maxToolCalls, 1, 64),
    maxRuntimeMs: positiveLimit(value.maxRuntimeMs, DEFAULT_RUFLO_LIMITS.maxRuntimeMs, 1, 300_000),
    maxRetries: positiveLimit(value.maxRetries, DEFAULT_RUFLO_LIMITS.maxRetries, 0, 5),
    maxAgentsPerSession: positiveLimit(value.maxAgentsPerSession, DEFAULT_RUFLO_LIMITS.maxAgentsPerSession, 1, 5),
    maxTotalIterations: positiveLimit(value.maxTotalIterations, DEFAULT_RUFLO_LIMITS.maxTotalIterations, 1, 32),
  };
}

function positiveLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value as number))) : fallback;
}

async function runPlannerWithFailover<T>(
  providers: AiProvider[],
  limits: RufloLimits,
  session: RufloSession,
  nowMs: () => number,
  operation: (provider: AiProvider) => Promise<T>,
  label: string,
): Promise<T> {
  let lastError: unknown = new Error(`Ruflo ${label} failed.`);
  for (let retry = 0; retry <= limits.maxRetries; retry += 1) {
    for (const provider of providers) {
      session.providerAttempts.push(provider.id);
      try {
        return await operation(provider);
      } catch (error) {
        lastError = error;
        if (!isRecoverable(error)) break;
      }
    }
    if (!isRecoverable(lastError) || retry >= limits.maxRetries) break;
    session.retries += 1;
    addEvent(session, "retry", `Retrying ${label} after a recoverable provider failure.`, nowMs);
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`Ruflo ${label} failed: ${errorMessage(lastError)}`);
}

async function runToolWithRetry(
  tools: RufloToolExecutor,
  request: RufloToolRequest,
  limits: RufloLimits,
  session: RufloSession,
  nowMs: () => number,
  elapsed: () => number,
): Promise<RufloToolResult> {
  let lastError: unknown = new Error(`${request.name} failed.`);
  for (let retry = 0; retry <= limits.maxRetries; retry += 1) {
    if (elapsed() >= limits.maxRuntimeMs) throw new Error("The Ruflo runtime limit was reached during bounded tool execution.");
    try {
      return await withRuntimeBudget(tools.execute(request), elapsed, limits.maxRuntimeMs);
    } catch (error) {
      lastError = error;
      if (!isRecoverable(error) || retry >= limits.maxRetries) break;
      if (session.toolCalls >= limits.maxToolCalls) break;
      session.toolCalls += 1;
      session.retries += 1;
      addEvent(session, "retry", `Retrying bounded ${request.name} after a recoverable tool failure.`, nowMs);
    }
  }
  if (lastError instanceof RufloRuntimeDeadlineError) throw lastError;
  throw new Error(`Ruflo tool ${request.name} failed: ${errorMessage(lastError)}`);
}

async function withRuntimeBudget<T>(
  operation: Promise<T>,
  elapsed: () => number,
  maxRuntimeMs: number,
): Promise<T> {
  const remaining = maxRuntimeMs - elapsed();
  if (remaining <= 0) throw new RufloRuntimeDeadlineError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new RufloRuntimeDeadlineError()), remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function enforceDecision(decision: RufloDecision, session: RufloSession): RufloDecision {
  if (decision.action === "inspect_repository" && session.observations.some((item) => item.tool === "inspect_repository" && item.status === "completed")) {
    return nextInspectionDecision(session, "Repository inspection is already complete.");
  }
  if (decision.action === "prepare_proposal" && session.discoveredFiles.length === 0) {
    return nextInspectionDecision(session, "Readable evidence is required before proposal-ready state.");
  }
  if (decision.action === "read_file") {
    const requested = cleanPath(decision.input?.path);
    const path = requested && !session.observations.some((item) => item.tool === "read_file" && item.result && readResultPath(item.result) === requested)
      ? requested
      : session.selectedFiles.find((candidate) => !session.observations.some((item) => item.tool === "read_file" && item.result && readResultPath(item.result) === candidate));
    if (!path) {
      return session.discoveredFiles.length ? { action: "prepare_proposal", reasoning: "All bounded relevant files have been read." } : nextInspectionDecision(session, "A bounded file is needed for evidence.");
    }
    return { ...decision, input: { ...decision.input, path } };
  }
  if (decision.action === "search_repository" && !decision.input?.query) {
    return { ...decision, input: { ...decision.input, query: session.task.slice(0, 240) } };
  }
  return decision;
}

function nextInspectionDecision(session: RufloSession, reasoning: string): RufloDecision {
  const path = session.selectedFiles.find((candidate) => !session.observations.some((item) => item.tool === "read_file" && item.result && readResultPath(item.result) === candidate));
  if (path) return { action: "read_file", reasoning, input: { path } };
  return { action: "search_repository", reasoning, input: { query: session.task.slice(0, 240) } };
}

function buildToolRequest(decision: RufloDecision, input: RufloRunInput, session: RufloSession): RufloToolRequest {
  if (decision.action === "prepare_proposal") throw new RufloRuntimeInputError("Proposal preparation is a runtime state, not an executable tool.");
  return {
    name: decision.action,
    input: decision.input ?? {},
    repository: input.repository,
    workspace: input.workspace,
    task: session.task,
  };
}

function observeToolResult(session: RufloSession, result: RufloToolResult, toolCallId: string): RufloObservation {
  const boundedData = boundValue(result.data);
  const observation: RufloObservation = {
    id: randomUUID(),
    toolCallId,
    iteration: session.iteration,
    tool: result.name,
    status: "completed",
    summary: result.summary.slice(0, 500),
    result: boundedData,
  };
  session.observations.push(observation);
  if (result.name === "inspect_repository" || result.name === "read_file") {
    session.context = `${session.context}\n\n${JSON.stringify(boundedData)}`.trim().slice(0, 32_000);
  } else {
    session.context = `${session.context}\n\nSearch observation: ${JSON.stringify(boundedData)}`.trim().slice(0, 32_000);
  }
  return observation;
}

function selectRepositoryFiles(task: string, overview: RepositoryOverview, explicit: string[]): string[] {
  if (explicit.length) return uniquePaths(explicit).slice(0, 20);
  const terms = task.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  const scored = overview.files.map((file) => {
    let score = 0;
    const lower = file.path.toLowerCase();
    for (const term of terms) if (lower.includes(term)) score += 5;
    if (file.path === "package.json" || /(^|\/)(app|main|index|server)\.[cm]?[jt]sx?$/.test(lower)) score += 4;
    if (/(api|route|server|database|auth|schema)/i.test(task) && ["api-server", "database", "authentication"].includes(file.category)) score += 6;
    if (/(ui|component|page|frontend|style|react)/i.test(task) && ["react-component", "styling"].includes(file.category)) score += 6;
    return { path: file.path, score };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return uniquePaths([
    ...overview.entryPoints,
    ...scored.filter((file) => file.score > 0).map((file) => file.path),
  ]).slice(0, 20);
}

function compactOverview(overview: RepositoryOverview, files: string[]): unknown {
  return {
    repository: overview.repository,
    framework: overview.framework,
    language: overview.language,
    packageManager: overview.packageManager,
    entryPoints: overview.entryPoints.slice(0, 20),
    relevantFiles: files,
    architecture: overview.architecture.slice(0, 12),
    files: overview.files.filter((file) => files.includes(file.path)).slice(0, 20),
  };
}

function readResultPath(value: unknown): string | undefined {
  return value && typeof value === "object" && "path" in value && typeof value.path === "string" ? value.path : undefined;
}

function uniqueProviders(providers: AiProvider[]): AiProvider[] {
  return providers.filter((provider, index, all) => all.findIndex((candidate) => candidate.id === provider.id) === index);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => cleanPath(path)).filter((path): path is string => Boolean(path)))].slice(0, 20);
}

function cleanPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.replace(/^@/, "").replaceAll("\\", "/").trim();
  if (!path || path.length > 500 || path.startsWith("../") || path.includes("/../") || path.startsWith("/") || path.includes("\u0000")) return undefined;
  return path;
}

function boundValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 12_000);
  if (Array.isArray(value)) return value.slice(0, 40).map(boundValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, boundValue(item)]));
}

function isRecoverable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("retryable" in error && error.retryable === true) return true;
  if ("code" in error && ["rate_limited", "timeout", "temporary_failure", "not_configured", "context_limit"].includes(String(error.code))) return true;
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failSession(
  session: RufloSession,
  code: RufloRuntimeError["code"],
  error: unknown,
  nowMs: () => number,
  publish?: () => void,
): RufloSession {
  session.status = "failed";
  session.proposalReady = false;
  session.error = { code, message: errorMessage(error), cause: error instanceof Error ? error.name : undefined };
  addEvent(session, "failed", session.error.message, nowMs);
  const finished = finishSession(session, nowMs);
  publish?.();
  return finished;
}

function finishSession(session: RufloSession, nowMs: () => number): RufloSession {
  session.updatedAt = new Date(nowMs()).toISOString();
  return session;
}

function addEvent(session: RufloSession, type: RufloEvent["type"], message: string, nowMs: () => number): void {
  session.events.push({
    id: randomUUID(),
    type,
    message: message.slice(0, 1_000),
    iteration: session.iteration,
    timestamp: new Date(nowMs()).toISOString(),
  });
  session.updatedAt = new Date(nowMs()).toISOString();
}