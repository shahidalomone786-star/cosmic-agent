import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { providerManager } from "../ai/provider-manager";
import { createRufloToolExecutor, runRufloSession, type RufloEvent, type RufloSession } from "../ruflo/ruflo-runtime";
import { rufloSessionStore } from "../ruflo/database-session-store";
import { getRepositoryOverview, readRepositoryFile, type RepositoryRef, type RepositoryFileCategory } from "../repository/github-provider";
import type { ChangeProposal } from "../ai/change-proposal";
import { createRufloProposal } from "../ruflo/ruflo-proposal";
import {
  commitProposal,
  executeProposal,
  getCommitReview,
  getPushReview,
  getRegisteredProposal,
  markProposalValidated,
  pushProposal,
  rejectAppliedProposal,
  stageProposal,
} from "../repository/patch-executor";
import { validateLocalWorkspace } from "../workspace/local-validation";
import { validateAppliedProposal } from "../ai/validator-runtime";
import { runRufloPostApproval, type RufloWorkflowPhase, MAX_RUFLO_RECOVERY_ATTEMPTS } from "../ruflo/ruflo-workflow";
import { runRufloPreparationAgents, type RufloAgentExecution, type RufloAgentRole, type RufloProposalOutput } from "../ruflo/ruflo-agents";
import { assertRemoteHeadMatches, GitHubWriteProviderError, githubWriteProvider } from "../repository/github-write-provider";
import { formatMemoryContext, projectMemoryKey, rufloMemoryStore } from "../ruflo/memory-store";
import { extractRufloLearning } from "../ruflo/memory-learning";
import { inspectWorkspace, readWorkspaceFile } from "../workspace/local-workspace";
import type { RufloMemory, RufloMemoryKind } from "../ruflo/types";
import {
  RufloModelRouter,
  RufloProviderGateway,
  type RufloCapabilityClass,
  type RufloRoutingDecision,
} from "../ruflo/ruflo-provider-router";
import {
  RufloCostTracker,
  estimateTokens,
  normalizeRufloBudgetLimits,
  type RufloBudgetLimits,
  type RufloCostTotals,
} from "../ruflo/ruflo-cost-tracker";
import { createDefaultRufloToolRegistry } from "../ruflo/ruflo-tool-registry";
import {
  RUFLO_PHASE9_EXCLUDED_TOOL_DEFINITIONS,
  RUFLO_PHASE9_IMPORTED_AGENTS,
  RUFLO_PHASE9_PLUGIN_CAPABILITIES,
  RUFLO_PHASE9_ORIGINAL,
} from "../ruflo/ruflo-phase9-catalog";
import {
  RufloMcpManager,
  RufloMcpManagerError,
  type RufloMcpScope,
  type RufloMcpToolPolicy,
} from "../ruflo/ruflo-mcp-manager";
import type { RufloMcpTransportConfiguration } from "../ruflo/ruflo-mcp-client";
import {
  canReadRufloSession,
  rufloLiveEventHub,
  type RufloLiveEventType,
  type RufloLiveStatus,
} from "../ruflo/ruflo-live-events";
import {
  runRufloSpecializedDag,
  selectRufloSpecializedAgents,
  type RufloBrowserAction,
  type RufloSpecializedAgentRole,
  type RufloSpecializedInspection,
  type RufloSpecializedInspectionFile,
  type RufloSpecializedInspectRequest,
} from "../ruflo/ruflo-specialized-agents";
import { InMemoryRufloJobStore, RufloJobManager, type RufloJobRecord } from "../ruflo/ruflo-jobs";
import {
  parseAgentAuth,
  RufloSwarmError,
  RufloSwarmService,
  topologyConnections,
  type RufloAgent,
  type RufloConsensus,
  type RufloSwarmMessage,
  type RufloSwarmTask,
} from "../ruflo/ruflo-swarm";
import { rufloSwarmRepository } from "../ruflo/ruflo-swarm-store";
import {
  buildPhase12Plan,
  Phase12Error,
} from "../ruflo/ruflo-phase12";

type RufloPublicActivity = {
  id: string;
  label:
    | "Planning"
    | "Inspecting Project"
    | "Searching Files"
    | "Reading Files"
    | "Delegating"
    | "Coding"
    | "Reviewing"
    | "Validating"
    | "Fixing"
     | "Testing"
     | "Documentation"
     | "Git Intelligence"
     | "Browser"
    | "Waiting for Approval"
    | "Applying"
    | "GitHub"
    | "Completed";
  status: "active" | "complete" | "failed";
  timestamp: string;
};

type RufloPublicGit = {
  status: "not-available" | "not-requested" | "ready" | "committed" | "pushed" | "unavailable";
  branch?: string;
};

type RufloPublicSession = {
  id: string;
  mode: "ruflo";
  task: string;
  status: "running" | "waiting" | "completed" | "failed";
  phase: RufloWorkflowPhase | "inspecting";
  currentLabel: RufloPublicActivity["label"];
  currentAgent:
    | "Ruflo Manager"
    | "Planner"
    | "Coder"
    | "Reviewer"
    | "Validator"
    | "Fixer"
    | "Test Generator"
    | "Documentation"
    | "Git Intelligence"
    | "Browser"
    | "Human approval";
  activity: RufloPublicActivity[];
  plan: string[];
  affectedFiles: string[];
  proposalStatus: "not-created" | "ready" | "applied" | "completed";
  validationStatus: "not-run" | "pass" | "fail" | "not-verified";
  git: RufloPublicGit;
  memoryFactCount: number;
  proposal?: ChangeProposal;
  error?: { code: string; message: string };
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  validation?: { status: "pass" | "fail" | "not-verified"; summary: string };
  workflowMessage?: string;
  agentExecutions: RufloPublicAgentExecution[];
  proposalAgent?: RufloPublicAgentExecution;
  createdAt: string;
  updatedAt: string;
  capability: RufloCapabilityClass;
  routing: {
    primary: { provider: string; model: string };
    fallbacks: Array<{ provider: string; model: string }>;
    reason: string;
  };
  usage: RufloCostTotals;
  tasks: RufloPublicTask[];
  agents: RufloPublicAgent[];
  executionWaves: Array<{ id: string; label: string; taskIds: string[]; status: "pending" | "active" | "complete" | "failed" }>;
  memory: { factCount: number; bounded: boolean; status: "available" | "empty" | "unavailable" };
  specializedAgents: RufloSpecializedAgentRole[];
  specializedProposals: ChangeProposal[];
  jobs: string[];
};

type RufloPublicTask = {
  id: string;
  title: string;
  status: "pending" | "active" | "complete" | "failed" | "blocked";
  dependencies: string[];
  wave: number;
  retryCount: number;
};

type RufloPublicAgent = {
  id: string;
  role: RufloPublicSession["currentAgent"];
  status: "idle" | "active" | "complete" | "failed";
  executionId?: string;
  attempts?: number;
};

type RufloPublicAgentExecution = {
  executionId: string;
  role: RufloAgentRole;
  status: "completed" | "failed";
  iteration: number;
  attempts: number;
  sourceExecutionIds: string[];
  completedAt: string;
};

type RuntimeEntry = {
  ownerId: string;
  model: string;
  capability: RufloCapabilityClass;
  routing: RufloRoutingDecision;
  providerGateway: RufloProviderGateway;
  costTracker: RufloCostTracker;
  projectKey: string;
  session?: RufloSession;
  proposal?: ChangeProposal;
  error?: { code: string; message: string };
  phase: RufloWorkflowPhase | "inspecting";
  recoveryAttempts: number;
  validation?: { status: "pass" | "fail" | "not-verified"; summary: string };
  workflowMessage?: string;
  agentExecutions: RufloAgentExecution<unknown>[];
  proposalAgent?: RufloAgentExecution<RufloProposalOutput>;
  activity: RufloPublicActivity[];
  currentAgent: RufloPublicSession["currentAgent"];
  proposalStatus: RufloPublicSession["proposalStatus"];
  git: RufloPublicGit;
  memoryFactCount: number;
  createdAt: string;
  usage?: RufloCostTotals;
  projectId: string;
  repository?: RepositoryRef;
  taskStates: Map<string, RufloPublicTask["status"]>;
  liveEventIds: Set<string>;
  specializedAgents: RufloSpecializedAgentRole[];
  specializedProposals: ChangeProposal[];
  jobs: string[];
};

const router: IRouter = Router();
const runtimeSessions = new Map<string, RuntimeEntry>();
const persistedEvents = new Map<string, Set<string>>();
const rufloExecutionLocks = new Set<string>();
const rufloJobManager = new RufloJobManager({
  store: new InMemoryRufloJobStore(),
  maxConcurrentJobs: 2,
  maxQueuedJobs: 16,
  defaultMaxRetries: 1,
  defaultMaxRuntimeMs: 120_000,
  onState: (job, event) => {
    const type: RufloLiveEventType = event === "queued"
      ? "job_queued"
      : event === "started"
        ? "job_started"
        : event === "completed"
          ? "job_completed"
          : event === "failed"
            ? "job_failed"
            : event === "cancelled"
              ? "job_cancelled"
              : "job_retrying";
    publishLive(job.sessionId, type, event === "failed" ? "failed" : event === "completed" ? "completed" : event === "cancelled" ? "queued" : "running", {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      attempts: job.attempts,
      maxRetries: job.maxRetries,
      error: job.error,
    });
    void rufloSessionStore.createActivity(job.ownerId, {
      sessionId: job.sessionId,
      kind: `job_${event}`,
      message: `Specialized job ${event}`,
    }).catch(() => undefined);
  },
});
const rufloModelRouter = new RufloModelRouter(providerManager.getProviders());
const rufloToolRegistry = createDefaultRufloToolRegistry();
const rufloMcpManager = new RufloMcpManager({
  registry: rufloToolRegistry,
  isSessionOwned: (userId, sessionId, projectId) => {
    const entry = runtimeSessions.get(sessionId);
    return Boolean(entry?.ownerId === userId && (!projectId || entry.projectId === projectId));
  },
});
const rufloSwarmService = new RufloSwarmService(rufloSwarmRepository, process.env.SESSION_SECRET ?? "");

router.use((req, res, next) => requireAuthenticatedUser(req, res) ? next() : undefined);

router.post("/ruflo/swarms", async (req, res) => {
  const userId = req.authUser!.id;
  const sessionId = stringBody(req.body?.sessionId);
  const projectId = optionalString(req.body?.projectId) ?? "default";
  const session = await rufloSessionStore.getSession(userId, sessionId);
  if (!session) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  try {
    const result = await rufloSwarmService.createSwarm(userId, {
      sessionId,
      projectId,
      topology: req.body?.topology,
      maxAgents: typeof req.body?.maxAgents === "number" ? req.body.maxAgents : undefined,
    });
    res.status(201).json({ swarm: result.swarm, leader: publicSwarmAgent(result.leader), credential: result.credential });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.get("/ruflo/swarms/:swarmId", async (req, res) => {
  try {
    const state = await rufloSwarmService.getState(req.authUser!.id, req.params.swarmId);
    res.json({
      ...state,
      agents: state.agents.map(publicSwarmAgent),
      connections: topologyConnections(state.swarm, state.agents),
      events: state.events.slice(-120),
    });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.get("/ruflo/swarms/:swarmId/agents", async (req, res) => {
  try {
    const agents = await rufloSwarmService.listAgents(req.authUser!.id, req.params.swarmId);
    res.json({ agents: agents.map(publicSwarmAgent) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/agents", async (req, res) => {
  try {
    const result = await rufloSwarmService.registerAgent(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), {
      name: stringBody(req.body?.name),
      type: optionalString(req.body?.type),
      role: req.body?.role,
      parentId: optionalString(req.body?.parentId),
      capabilities: Array.isArray(req.body?.capabilities) ? req.body.capabilities.filter((value: unknown): value is string => typeof value === "string") : undefined,
    });
    res.status(201).json({ agent: publicSwarmAgent(result.agent), credential: result.credential });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/messages", async (req, res) => {
  try {
    const message = await rufloSwarmService.sendMessage(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), {
      toAgentId: stringBody(req.body?.toAgentId),
      type: stringBody(req.body?.type),
      payload: recordBody(req.body?.payload),
    });
    res.status(201).json({ message: publicSwarmMessage(message) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.get("/ruflo/swarms/:swarmId/agents/:agentId/mailbox", async (req, res) => {
  try {
    const messages = await rufloSwarmService.readMailbox(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.params.agentId, req.query.credential), numberQuery(req.query.limit, 24));
    res.json({ messages: messages.map(publicSwarmMessage) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/messages/:messageId/ack", async (req, res) => {
  try {
    const message = await rufloSwarmService.acknowledgeMessage(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), req.params.messageId);
    res.json({ message: publicSwarmMessage(message) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.get("/ruflo/swarms/:swarmId/context", async (req, res) => {
  try {
    const entries = await rufloSwarmService.readContext(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.query.agentId, req.query.credential), optionalString(req.query.namespace));
    res.json({ entries });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.put("/ruflo/swarms/:swarmId/context", async (req, res) => {
  try {
    const entry = await rufloSwarmService.writeContext(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), {
      namespace: stringBody(req.body?.namespace),
      key: stringBody(req.body?.key),
      value: req.body?.value,
      expectedVersion: typeof req.body?.expectedVersion === "number" ? req.body.expectedVersion : undefined,
    });
    res.json({ entry });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/subscriptions", async (req, res) => {
  try {
    const subscription = await rufloSwarmService.subscribe(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), stringBody(req.body?.eventType));
    res.status(201).json({ subscription });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.get("/ruflo/swarms/:swarmId/events", async (req, res) => {
  try {
    const events = await rufloSwarmService.listEvents(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.query.agentId, req.query.credential), numberQuery(req.query.after, 0));
    res.json({ events });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/agents/:agentId/heartbeat", async (req, res) => {
  try {
    const agent = await rufloSwarmService.heartbeat(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.params.agentId, req.body?.credential));
    res.json({ agent: publicSwarmAgent(agent) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/tasks", async (req, res) => {
  try {
    const task = await rufloSwarmService.createTask(req.authUser!.id, req.params.swarmId, {
      title: stringBody(req.body?.title),
      description: optionalString(req.body?.description),
      payload: recordBody(req.body?.payload),
    });
    res.status(201).json({ task });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.get("/ruflo/swarms/:swarmId/tasks", async (req, res) => {
  try {
    res.json({ tasks: await rufloSwarmService.listTasks(req.authUser!.id, req.params.swarmId) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/tasks/:taskId/lease", async (req, res) => {
  try {
    const task = await rufloSwarmService.acquireTaskLease(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), req.params.taskId);
    res.json({ task });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/tasks/:taskId/complete", async (req, res) => {
  try {
    const task = await rufloSwarmService.completeTask(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), req.params.taskId, {
      result: req.body?.result,
      error: optionalString(req.body?.error),
    });
    res.json({ task });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/consensus", async (req, res) => {
  try {
    const consensus = await rufloSwarmService.createConsensus(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), {
      type: stringBody(req.body?.type),
      payload: recordBody(req.body?.payload),
      voterAgentIds: Array.isArray(req.body?.voterAgentIds) ? req.body.voterAgentIds.filter((value: unknown): value is string => typeof value === "string") : undefined,
      strategy: req.body?.strategy,
    });
    res.status(201).json({ consensus: publicConsensus(consensus) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/consensus/:consensusId/vote", async (req, res) => {
  try {
    const consensus = await rufloSwarmService.vote(req.authUser!.id, req.params.swarmId, parseAgentAuth(req.body?.agentId, req.body?.credential), req.params.consensusId, req.body?.value);
    res.json({ consensus: publicConsensus(consensus) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.post("/ruflo/swarms/:swarmId/cancel", async (req, res) => {
  try {
    res.json({ swarm: await rufloSwarmService.cancelSwarm(req.authUser!.id, req.params.swarmId) });
  } catch (error) {
    sendRufloSwarmError(res, error);
  }
});

router.get("/ruflo/providers", (_req, res) => {
  res.json({
    providers: rufloModelRouter.discover().map((availability) => ({
      provider: availability.provider,
      health: availability.health,
      models: availability.models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        capabilities: model.capabilities,
        capabilityClasses: model.capabilityClasses,
        contextWindow: model.contextWindow,
        enabled: model.enabled,
        recommended: model.recommended,
        costTier: model.costTier,
      })),
    })),
    unsupportedProviders: ["openai", "anthropic", "cohere", "ollama"],
  });
});

router.get("/ruflo/tools", (_req, res) => {
  res.json({
    tools: rufloToolRegistry.list().map((tool) => ({
      ...tool,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })),
  });
});

router.get("/ruflo/catalog", (_req, res) => {
  res.json({
    original: RUFLO_PHASE9_ORIGINAL,
    tools: rufloToolRegistry.list().map((tool) => ({
      ...tool,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })),
    importedAgents: RUFLO_PHASE9_IMPORTED_AGENTS,
    pluginCapabilities: RUFLO_PHASE9_PLUGIN_CAPABILITIES,
    excludedToolDefinitions: RUFLO_PHASE9_EXCLUDED_TOOL_DEFINITIONS.map((tool) => ({
      id: tool.id,
      description: tool.description,
      sourcePath: tool.provenance.sourcePath,
      reason: tool.description,
    })),
  });
});

router.get("/ruflo/mcp/servers", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId.trim().slice(0, 80) : undefined;
  res.json({ servers: rufloMcpManager.list(req.authUser!.id, projectId).map(publicMcpConfiguration) });
});

router.post("/ruflo/mcp/servers", (req, res) => {
  try {
    const configuration = rufloMcpManager.configure(parseMcpConfiguration(req.authUser!.id, req.body));
    res.status(201).json({ server: publicMcpConfiguration(configuration) });
  } catch (error) {
    sendMcpError(res, error);
  }
});

router.post("/ruflo/mcp/servers/:serverName/discover", async (req, res) => {
  try {
    const tools = await rufloMcpManager.discover(req.authUser!.id, req.params.serverName);
    res.json({ tools: tools.map(publicMcpTool) });
  } catch (error) {
    sendMcpError(res, error);
  }
});

router.post("/ruflo/mcp/servers/:serverName/enable", async (req, res) => {
  try {
    const enabled = req.body?.enabled !== false;
    const server = await rufloMcpManager.setEnabled(req.authUser!.id, req.params.serverName, enabled);
    res.json({ server: publicMcpConfiguration(server) });
  } catch (error) {
    sendMcpError(res, error);
  }
});

router.post("/ruflo/mcp/tools/:toolId/approve", (req, res) => {
  try {
    const approval = rufloMcpManager.approveTool({
      userId: req.authUser!.id,
      sessionId: stringBody(req.body?.sessionId),
      taskId: optionalString(req.body?.taskId),
      toolId: decodeURIComponent(req.params.toolId),
      input: req.body?.input,
    });
    res.status(201).json(approval);
  } catch (error) {
    sendMcpError(res, error);
  }
});

router.post("/ruflo/mcp/tools/:toolId/execute", async (req, res) => {
  const result = await rufloMcpManager.executeTool({
    userId: req.authUser!.id,
    sessionId: stringBody(req.body?.sessionId),
    taskId: optionalString(req.body?.taskId),
    toolId: decodeURIComponent(req.params.toolId),
    input: req.body?.input,
    approvalId: optionalString(req.body?.approvalId),
  });
  res.status(result.ok ? 200 : result.error.category === "approval_required" ? 428 : result.error.category === "session_unauthorized" ? 403 : 422).json(result);
});

router.get("/ruflo/memory", async (req, res) => {
  const userId = req.authUser!.id;
  const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim()
    ? req.query.projectId.trim().slice(0, 80)
    : "default";
  const query = typeof req.query.query === "string" ? req.query.query.trim().slice(0, 500) : "";
  const requestedLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 12;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(24, Math.floor(requestedLimit))) : 12;
  try {
    const projectKey = projectMemoryKey({ projectId });
    const memories = await rufloMemoryStore.retrieveRelevant(userId, projectKey, { query, limit });
    res.json({
      projectKey,
      memories: memories.map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        fact: memory.fact,
        relevance: memory.relevance,
        confidence: memory.confidence,
        importance: memory.importance,
        sourceSessionId: memory.sourceSessionId,
        sourceTaskId: memory.sourceTaskId,
        successCount: memory.successCount,
        failureCount: memory.failureCount,
        lastUsedAt: memory.lastUsedAt,
        embeddingProvider: memory.embeddingProvider,
        embeddingModel: memory.embeddingModel,
      })),
    });
  } catch (error) {
    logger.warn({ err: error, userId, projectId }, "Ruflo memory query failed");
    res.status(503).json({ error: "Ruflo memory is temporarily unavailable.", code: "memory_unavailable" });
  }
});

router.post("/ruflo/sessions", async (req, res) => {
  const userId = req.authUser!.id;
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  const requestedModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  const requestedCapability = isRufloCapability(req.body?.capability) ? req.body.capability : undefined;
  const projectId = typeof req.body?.projectId === "string" && req.body.projectId.trim()
    ? req.body.projectId.trim().slice(0, 80)
    : "default";
  const repository = parseRepository(req.body?.repository);
  const selectedFiles = Array.isArray(req.body?.selectedFiles)
    ? req.body.selectedFiles.filter((item: unknown): item is string => typeof item === "string").slice(0, 20)
    : [];

  if (!task) {
    res.status(400).json({ error: "Describe the task for Ruflo to inspect.", code: "invalid_request" });
    return;
  }

  try {
    const projectKey = projectMemoryKey({ projectId, repository });
    let memory: RufloMemory[] = [];
    try {
      memory = await rufloMemoryStore.retrieveRelevant(userId, projectKey, { query: task, limit: 12 });
    } catch (error) {
      logger.warn({ err: error, userId, projectKey }, "Ruflo memory retrieval skipped");
    }
    const budget = normalizeRufloBudgetLimits(parseBudget(req.body?.budget));
    const routing = rufloModelRouter.select({
      task,
      capability: requestedCapability,
      requestedModel: requestedModel || undefined,
      contextTokens: estimateTokens(`${task}\n${formatMemoryContext(memory)}`),
      outputTokens: 2_048,
      remainingTokens: budget.maxSessionTokens,
    });
    const stored = await rufloSessionStore.createSession(userId, { goal: task });
    const costTracker = new RufloCostTracker({ limits: budget });
    const provider = new RufloProviderGateway(routing, costTracker, {
      sessionId: stored.id,
      capability: routing.capability,
      onAttempt: (attempt) => {
        if (!attempt.fallbackUsed && !attempt.classification) return;
        logger.info({
          sessionId: stored.id,
          provider: attempt.provider,
          model: attempt.model,
          capability: attempt.capability,
          fallbackUsed: attempt.fallbackUsed,
          failureClass: attempt.classification,
        }, "Ruflo provider route attempt");
        publishLive(
          stored.id,
          attempt.fallbackUsed ? "provider_fallback" : "provider_selected",
          "running",
          {
            provider: attempt.provider,
            model: attempt.model,
            capability: attempt.capability,
            fallbackUsed: attempt.fallbackUsed,
            classification: attempt.classification,
          },
        );
      },
    });
    const createdAt = stored.createdAt.toISOString();
    const initialActivity: RufloPublicActivity = {
      id: `${stored.id}-planning`,
      label: "Planning",
      status: "active",
      timestamp: createdAt,
    };
    const entry: RuntimeEntry = {
      ownerId: userId,
      model: routing.primary.model.id,
      capability: routing.capability,
      routing,
      providerGateway: provider,
      costTracker,
      projectKey,
      activity: [initialActivity],
      createdAt,
      phase: "inspecting",
      recoveryAttempts: 0,
      agentExecutions: [],
      currentAgent: "Planner",
      proposalStatus: "not-created",
      git: { status: repository ? "not-requested" : "not-available", branch: repository?.branch },
      memoryFactCount: memory.length,
      projectId,
      repository,
      taskStates: new Map(),
      liveEventIds: new Set(),
      specializedAgents: [],
      specializedProposals: [],
      jobs: [],
    };
    runtimeSessions.set(stored.id, entry);
    persistedEvents.set(stored.id, new Set());
    await rufloSessionStore.updateSessionStatus(userId, stored.id, "active");
    await rufloSessionStore.createActivity(userId, {
      sessionId: stored.id,
      kind: "planning",
      message: "Planning",
    });
    publishLive(stored.id, "session_started", "running", { phase: "inspecting", capability: routing.capability });
    if (memory.length) publishLive(stored.id, "memory_retrieved", "running", { count: memory.length, bounded: true });
    publishLive(stored.id, "provider_selected", "running", {
      provider: routing.primary.provider.id,
      model: routing.primary.model.id,
      capability: routing.capability,
      fallbackCount: routing.fallbacks.length,
    });
    publishLive(stored.id, "agent_started", "active", { role: "Planner" });

    const run = runRufloSession({
      sessionId: stored.id,
      task,
      model: routing.primary.model.id,
      provider,
      tools: createRufloToolExecutor(rufloToolRegistry),
      capability: routing.capability,
      budget,
      costTracker,
      repository,
      workspace: repository ? undefined : { userId, projectId },
      selectedFiles,
      memoryContext: formatMemoryContext(memory),
      onUpdate: (session) => {
        const current = runtimeSessions.get(session.id);
        if (!current) return;
        current.session = session;
        current.usage = costTracker.getSessionTotals(session.id);
         publishRuntimeEvents(current, session);
         publishPlanTaskEvents(current, session);
        const seen = persistedEvents.get(session.id) ?? new Set<string>();
        for (const event of session.events) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          const activity = activityForEvent(event);
          if (activity) {
             addPublicActivity(current, activity);
            void rufloSessionStore.createActivity(userId, {
              sessionId: session.id,
              kind: activity.label.toLowerCase().replaceAll(" ", "_"),
              message: activity.label,
            }).catch(() => undefined);
          }
        }
        persistedEvents.set(session.id, seen);
         publishLive(session.id, "session_state", liveStatusForEntry(current), {
           session: publicLiveSession(publicSession(session.id, current)),
         });
      },
    });

    void run.then(async (session) => {
      const current = runtimeSessions.get(session.id);
      if (session.status === "proposal_ready" && current) {
        addPublicActivity(current, {
          id: `${session.id}-proposal`,
          label: "Delegating",
          status: "active",
          timestamp: new Date().toISOString(),
        });
        void persistActivity(userId, session.id, current.activity.at(-1));
        try {
          const preparation = await runRufloPreparationAgents({
            session,
            limits: session.agentLimits,
            existingExecutions: current.agentExecutions,
            onExecution: (execution) => {
              current.agentExecutions = [...current.agentExecutions, execution];
              current.currentAgent = agentRoleLabel(execution.role);
              addPublicActivity(current, {
                id: `${session.id}-${execution.executionId}`,
                label: agentActivityLabel(execution.role),
                status: execution.status === "failed" ? "failed" : "complete",
                timestamp: execution.completedAt,
              });
              void persistActivity(userId, session.id, current.activity.at(-1));
              publishLive(session.id, execution.status === "failed" ? "agent_failed" : "agent_completed", execution.status === "failed" ? "failed" : "completed", {
                role: agentRoleLabel(execution.role),
                executionId: execution.executionId,
                attempts: execution.attempts,
                iteration: execution.iteration,
              });
            },
            createProposal: (delegation) => createRufloProposal({
              provider,
              model: routing.primary.model.id,
              session: {
                ...session,
                task: delegation.task,
                selectedFiles: delegation.selectedFiles,
                context: delegation.context,
              },
              repository,
              ownerId: userId,
              workspace: repository ? undefined : { userId, projectId },
            }),
          });
          current.agentExecutions = preparation.executions;
          current.usage = costTracker.getSessionTotals(session.id);
          current.proposalAgent = preparation.coder;
          current.proposal = preparation.coder.output!.proposal;
          current.proposalStatus = "ready";
          current.phase = "waiting_approval";
          addPublicActivity(current, {
            id: `${session.id}-waiting`,
            label: "Waiting for Approval",
            status: "active",
            timestamp: new Date().toISOString(),
          });
          void persistActivity(userId, session.id, current.activity.at(-1));
          publishLive(session.id, "proposal_created", "waiting", { proposalId: current.proposal?.proposalId, fileCount: current.proposal?.files.length ?? 0 });
          publishLive(session.id, "approval_requested", "waiting", { proposalId: current.proposal?.proposalId, risk: current.proposal?.risk });
        } catch (error) {
          current.error = proposalError(error);
          markLastActivityFailed(current);
          logger.error({ err: error, sessionId: session.id }, "Ruflo proposal generation failed");
          publishLive(session.id, "session_failed", "failed", { code: current.error.code, message: current.error.message });
        }
      }
      await rememberRufloSessionFacts(userId, projectKey, session);
      if (current && current.memoryFactCount < memory.length) {
        current.memoryFactCount = memory.length;
        publishLive(session.id, "memory_learned", "completed", { count: current.memoryFactCount, bounded: true });
      }
      if (current) {
        const failed = session.status === "failed" || session.status === "limit_reached" || Boolean(current.error);
        if (failed) {
          publishLive(session.id, "session_failed", "failed", { status: session.status, phase: current.phase, usage: current.usage });
        } else if (current.phase === "waiting_approval") {
          publishLive(session.id, "session_state", "waiting", { status: session.status, phase: current.phase, usage: current.usage });
        } else {
          publishLive(session.id, "session_completed", "completed", { status: session.status, phase: current.phase, usage: current.usage });
        }
      }
      const status = session.status === "failed" || session.status === "limit_reached" || current?.error
        ? "failed"
        : current?.phase === "waiting_approval"
          ? "active"
          : "completed";
      await rufloSessionStore.updateSessionStatus(userId, session.id, status);
    }).catch(async (error: unknown) => {
      logger.error({ err: error, sessionId: stored.id }, "Ruflo session stopped unexpectedly");
      const current = runtimeSessions.get(stored.id);
      if (current) {
        markLastActivityFailed(current);
        publishLive(stored.id, "session_failed", "failed", { code: "runtime_failure", message: "The Ruflo session stopped unexpectedly." });
      }
      await rufloSessionStore.updateSessionStatus(userId, stored.id, "failed").catch(() => undefined);
    });

    res.status(201).json(publicSession(stored.id, entry));
  } catch (error) {
    res.status(400).json({ error: publicError(error), code: "ruflo_start_failed" });
  }
});

router.get("/ruflo/sessions/:sessionId/phase12/plan", async (req, res) => {
  const userId = req.authUser!.id;
  const sessionId = stringBody(req.params.sessionId);
  const entry = runtimeSessions.get(sessionId);
  if (!entry || entry.ownerId !== userId) {
    res.status(404).json({ error: "Ruflo session was not found.", code: "session_not_found" });
    return;
  }
  if (!entry.session) {
    res.status(409).json({
      error: "The bounded Ruflo inspection has not completed, so a Phase 12 plan cannot be created yet.",
      code: "session_not_ready",
    });
    return;
  }
  try {
    const plan = buildPhase12Plan({
      session: entry.session,
      userId,
      projectId: entry.projectId,
      repository: entry.repository,
      memoryFacts: entry.memoryFactCount,
      registry: rufloToolRegistry,
    });
    await rufloSessionStore.createActivity(userId, {
      sessionId,
      kind: "phase12_plan_created",
      message: `Phase 12 plan ${plan.taskId} created with ${plan.nodes.length} bounded nodes.`,
    });
    res.json(plan);
  } catch (error) {
    if (error instanceof Phase12Error) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }
    logger.error({ err: error, sessionId, userId }, "Unable to create Phase 12 plan");
    res.status(500).json({ error: "Unable to create the Phase 12 plan.", code: "phase12_plan_failed" });
  }
});

router.post("/ruflo/sessions/:sessionId/specialized", async (req, res) => {
  const userId = req.authUser!.id;
  const sessionId = req.params.sessionId;
  const entry = runtimeSessions.get(sessionId);
  if (!entry || entry.ownerId !== userId || !entry.session) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  const task = typeof req.body?.task === "string" && req.body.task.trim()
    ? req.body.task.trim().slice(0, 2_000)
    : entry.session.task;
  const selectedFiles = Array.isArray(req.body?.selectedFiles)
    ? req.body.selectedFiles.filter((item: unknown): item is string => typeof item === "string").slice(0, 24)
    : entry.session.selectedFiles.slice(0, 24);
  const requestedRoles: RufloSpecializedAgentRole[] = Array.isArray(req.body?.roles)
    ? req.body.roles.filter((role: unknown): role is RufloSpecializedAgentRole =>
      role === "test_generator" || role === "documentation" || role === "git_intelligence" || role === "browser",
    ).slice(0, 4)
    : [];
  const roles = requestedRoles.length
    ? [...new Set(requestedRoles)]
    : entry.session.plan.specializedAgents?.length
      ? entry.session.plan.specializedAgents
      : selectRufloSpecializedAgents(task);
  if (!roles.length) {
    res.status(400).json({ error: "No specialized Ruflo agent is required for this task.", code: "no_specialized_agent" });
    return;
  }

  const browserUrls = Array.isArray(req.body?.urls)
    ? req.body.urls.filter((item: unknown): item is string => typeof item === "string").slice(0, 8)
    : [];
  const browserAllowedOrigins = Array.isArray(req.body?.allowedOrigins)
    ? req.body.allowedOrigins.filter((item: unknown): item is string => typeof item === "string").slice(0, 8)
    : [];
  const browserActions = Array.isArray(req.body?.actions)
    ? req.body.actions.filter(isBrowserAction).slice(0, 30)
    : [];
  const onExecution = (execution: RufloAgentExecution<unknown>) => {
    entry.agentExecutions = [...entry.agentExecutions, execution].slice(-64);
    entry.currentAgent = agentRoleLabel(execution.role);
    if (execution.output && typeof execution.output === "object" && "proposal" in execution.output && execution.output.proposal) {
      const proposal = execution.output.proposal as ChangeProposal;
      entry.specializedProposals = [...entry.specializedProposals, proposal].slice(-8);
      if (!entry.proposal) {
        entry.proposal = proposal;
        entry.proposalStatus = "ready";
        entry.phase = "waiting_approval";
      }
      publishLive(sessionId, "proposal_created", "waiting", { proposalId: proposal.proposalId, sourceRole: execution.role });
    }
    publishLive(sessionId, execution.status === "failed" ? "agent_failed" : "agent_completed", execution.status === "failed" ? "failed" : "completed", {
      role: agentRoleLabel(execution.role),
      executionId: execution.executionId,
      attempts: execution.attempts,
      specialized: true,
      analysis: execution.output && typeof execution.output === "object" && "analysis" in execution.output ? execution.output.analysis : undefined,
    });
    const eventType: RufloLiveEventType | undefined = execution.role === "test_generator"
      ? "test_generation"
      : execution.role === "documentation"
        ? "documentation_analysis"
        : execution.role === "git_intelligence"
          ? "git_analysis"
          : "browser_activity";
    if (eventType) publishLive(sessionId, eventType, execution.status === "failed" ? "failed" : "completed", {
      role: execution.role,
      summary: execution.output && typeof execution.output === "object" && "summary" in execution.output ? execution.output.summary : undefined,
      readFiles: execution.output && typeof execution.output === "object" && "readFiles" in execution.output ? execution.output.readFiles : [],
      changedFiles: execution.output && typeof execution.output === "object" && "changedFiles" in execution.output ? execution.output.changedFiles : [],
    });
  };

  try {
    const job = await rufloJobManager.enqueue({
      ownerId: userId,
      sessionId,
      kind: "specialized_agents",
      maxRetries: 1,
      maxRuntimeMs: 120_000,
      execute: async ({ signal }) => {
        for (const role of roles) publishLive(sessionId, "agent_selected", "queued", { role, specialized: true });
        const result = await runRufloSpecializedDag({
          sessionId,
          task,
          selectedFiles,
          roles,
          signal,
          inspect: (request) => inspectForSpecializedAgent(entry, request, userId),
          createProposal: (request) => createRufloProposal({
            provider: entry.providerGateway,
            model: entry.model,
            session: {
              ...entry.session!,
              task: request.task,
              selectedFiles: request.paths,
              context: request.context,
            },
            repository: entry.repository,
            ownerId: userId,
            workspace: entry.repository ? undefined : { userId, projectId: entry.projectId },
          }),
          git: entry.repository
            ? async () => {
              const status = await githubWriteProvider.getStatus(entry.repository!, entry.repository!.branch, selectedFiles);
              const diff = await githubWriteProvider.getDiff(entry.repository!, entry.repository!.branch);
              return {
                status: { branch: status.branch, clean: status.clean, stagedFiles: status.stagedFiles },
                branches: [status.branch],
                commits: [],
                diffs: diff.files,
                changedFiles: diff.files.map((file) => file.path),
                references: [entry.repository!.webUrl],
              };
            }
            : undefined,
          browser: {
            urls: browserUrls,
            actions: browserActions,
            allowedOrigins: browserAllowedOrigins,
          },
          onAgent: onExecution,
          onTask: (dagTask) => {
            const type: RufloLiveEventType = dagTask.status === "in_progress"
              ? "task_running"
              : dagTask.status === "completed"
                ? "task_completed"
                : dagTask.status === "failed"
                  ? "task_failed"
                  : "task_queued";
            publishLive(sessionId, type, dagTask.status === "completed" ? "completed" : dagTask.status === "failed" ? "failed" : dagTask.status === "in_progress" ? "running" : "queued", {
              title: dagTask.description,
              role: dagTask.role,
              attempts: dagTask.attempts,
            }, dagTask.taskId);
          },
          remember: async ({ kind, fact, sourceTaskId, outcome }) => {
            await rufloMemoryStore.remember(userId, {
              projectKey: entry.projectKey,
              sourceSessionId: sessionId,
              sourceTaskId,
              kind,
              fact,
              confidence: outcome === "success" ? 0.65 : 0.4,
              importance: 45,
              outcome,
            });
          },
        });
        return { message: result.message, status: result.status, completed: result.completedTaskIds.length, failed: result.failedTaskIds.length };
      },
    });
    entry.specializedAgents = roles;
    entry.jobs = [...entry.jobs, job.id].slice(-16);
    res.status(202).json({ job, specializedAgents: roles });
  } catch (error) {
    res.status(429).json({ error: publicError(error), code: "specialized_job_rejected" });
  }
});

router.get("/ruflo/jobs/:jobId", async (req, res) => {
  const job = await rufloJobManager.get(req.authUser!.id, req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Ruflo job not found.", code: "not_found" });
    return;
  }
  res.json(job);
});

router.post("/ruflo/jobs/:jobId/cancel", async (req, res) => {
  const job = await rufloJobManager.cancel(req.authUser!.id, req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Ruflo job not found.", code: "not_found" });
    return;
  }
  res.json(job);
});

router.post("/ruflo/sessions/:sessionId/execute", async (req, res) => {
  const userId = req.authUser!.id;
  const entry = runtimeSessions.get(req.params.sessionId);
  if (!entry || entry.ownerId !== userId) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId.trim() : "";
  if (!proposalId || !approvalId || !entry.proposal || entry.proposal.proposalId !== proposalId || !entry.session || entry.phase !== "waiting_approval") {
    res.status(400).json({ error: "Ruflo approval requires the current proposal and server-held approval.", code: "invalid_approval" });
    return;
  }
  if (rufloExecutionLocks.has(req.params.sessionId)) {
    res.status(409).json({ error: "This Ruflo approval is already being processed.", code: "execution_in_progress" });
    return;
  }

  let applied = false;
  rufloExecutionLocks.add(req.params.sessionId);
  try {
    const registered = getRegisteredProposal(proposalId);
    if (!registered || registered.ownerId !== userId) {
      res.status(404).json({ error: "Ruflo proposal not found for the authenticated user.", code: "not_found" });
      return;
    }
    publishLive(req.params.sessionId, "approval_approved", "running", { proposalId });
    publishLive(req.params.sessionId, "lock_acquired", "active", { scope: "proposal_execution" });
    addPublicActivity(entry, {
      id: `${req.params.sessionId}-applying-${Date.now()}`,
      label: "Applying",
      status: "active",
      timestamp: new Date().toISOString(),
    });
    void persistActivity(userId, req.params.sessionId, entry.activity.at(-1));
    const execution = await executeProposal(proposalId, approvalId);
    applied = execution.status === "applied";
    entry.proposalStatus = "applied";
    const workflow = await runRufloPostApproval({
      proposal: entry.proposal,
      boundedPaths: entry.session.selectedFiles,
      recoveryAttempts: entry.recoveryAttempts,
      proposalAgent: entry.proposalAgent,
      agentExecutions: entry.agentExecutions,
      agentLimits: entry.session.agentLimits,
      onAgent: (agentExecution) => {
        entry.agentExecutions = [...entry.agentExecutions, agentExecution];
        entry.currentAgent = agentRoleLabel(agentExecution.role);
        addPublicActivity(entry, {
          id: `${req.params.sessionId}-${agentExecution.executionId}`,
          label: agentActivityLabel(agentExecution.role),
          status: agentExecution.status === "failed" ? "failed" : "complete",
          timestamp: agentExecution.completedAt,
        });
        void persistActivity(userId, req.params.sessionId, entry.activity.at(-1));
        publishLive(req.params.sessionId, agentExecution.status === "failed" ? "agent_failed" : "agent_completed", agentExecution.status === "failed" ? "failed" : "completed", {
          role: agentRoleLabel(agentExecution.role),
          executionId: agentExecution.executionId,
          attempts: agentExecution.attempts,
          iteration: agentExecution.iteration,
        });
      },
      appliedResult: execution,
      validator: async (proposal, appliedResult) => {
        if (!appliedResult || typeof appliedResult !== "object" || !("status" in appliedResult) || appliedResult.status !== "applied") {
          return { status: "not-verified", summary: "Validator did not receive a server-confirmed applied result." };
        }
        if (registered.workspaceRoot) {
          const result = await validateLocalWorkspace(registered.workspaceRoot, proposal);
          return { status: result.status, summary: result.summary };
        }
        const result = await validateAppliedProposal(
          entry.providerGateway,
          proposal.proposalId,
        );
        return { status: result.status, summary: result.summary };
      },
      rollback: () => rejectAppliedProposal(proposalId),
      createFixProposal: (diagnosis, attempt) => createRufloFixProposal({
        entry,
        diagnosis,
        attempt,
        provider: entry.providerGateway,
        model: entry.model,
        repository: registered.repository,
        workspace: registered.workspaceRoot ? { userId, projectId: registered.projectId ?? "default" } : undefined,
        ownerId: userId,
      }),
       onPhase: (phase) => updateWorkflowPhase(entry, phase, userId, req.params.sessionId),
    });
    entry.recoveryAttempts = workflow.recoveryAttempts;
    entry.validation = workflow.validation;
    entry.workflowMessage = workflow.message;
    entry.agentExecutions = workflow.agentExecutions;
    entry.usage = entry.costTracker.getSessionTotals(req.params.sessionId);
    publishLive(req.params.sessionId, "cost_update", liveStatusForEntry(entry), { usage: entry.usage });
    entry.proposalAgent = workflow.proposalAgent ?? entry.proposalAgent;
    if (workflow.proposal) {
      entry.proposal = workflow.proposal;
      entry.proposalStatus = "ready";
    } else if (workflow.status === "completed") {
      entry.proposalStatus = "completed";
    }
    await rememberRufloOutcome(userId, entry, workflow);
    if (workflow.status === "completed") {
      markProposalValidated(proposalId, true);
      await rufloSessionStore.updateSessionStatus(userId, req.params.sessionId, "completed");
      publishLive(req.params.sessionId, "validation_completed", "completed", { status: workflow.validation?.status, summary: workflow.validation?.summary });
      publishLive(req.params.sessionId, "session_completed", "completed", { phase: workflow.phase, usage: entry.usage });
    } else if (workflow.status === "failed") {
      entry.error = { code: "workflow_failed", message: workflow.message };
      await rufloSessionStore.updateSessionStatus(userId, req.params.sessionId, "failed");
      publishLive(req.params.sessionId, "validation_failed", "failed", { status: workflow.validation?.status, summary: workflow.validation?.summary });
      publishLive(req.params.sessionId, "session_failed", "failed", { code: entry.error.code, message: entry.error.message });
    } else {
      await rufloSessionStore.updateSessionStatus(userId, req.params.sessionId, "active");
      publishLive(req.params.sessionId, "approval_requested", "waiting", { proposalId: workflow.proposal?.proposalId, recoveryAttempts: workflow.recoveryAttempts });
    }
    publishLive(req.params.sessionId, "lock_released", liveStatusForEntry(entry), { scope: "proposal_execution" });
    res.json({
      ...execution,
      workflow,
    });
  } catch (error) {
    if (applied) await rejectAppliedProposal(proposalId).catch(() => undefined);
    entry.phase = "failed";
    markLastActivityFailed(entry);
    entry.error = { code: "workflow_failed", message: publicError(error) };
    entry.workflowMessage = entry.error.message;
    res.status(422).json({ error: entry.error.message, code: "workflow_failed" });
  } finally {
    rufloExecutionLocks.delete(req.params.sessionId);
  }
});

router.post("/ruflo/sessions/:sessionId/git/commit-review", async (req, res) => {
  const userId = req.authUser!.id;
  const entry = runtimeSessions.get(req.params.sessionId);
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  if (!entry || entry.ownerId !== userId) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  if (!proposalId || !entry.proposal || entry.proposal.proposalId !== proposalId) {
    res.status(400).json({ error: "Git review requires the current Ruflo proposal.", code: "invalid_proposal" });
    return;
  }
  try {
    const review = await getCommitReview(proposalId);
    const permission = await githubWriteProvider.checkRepositoryPermission(review.repository, review.branch);
    entry.git = { status: "ready", branch: review.branch };
    addPublicActivity(entry, {
      id: `${req.params.sessionId}-github-commit-review`,
      label: "GitHub",
      status: "complete",
      timestamp: new Date().toISOString(),
    });
    res.json({ ...review, permission });
  } catch (error) {
    entry.git = { status: "unavailable", branch: entry.git.branch };
    sendRufloGitError(res, error);
  }
});

router.post("/ruflo/sessions/:sessionId/git/commit", async (req, res) => {
  const userId = req.authUser!.id;
  const entry = runtimeSessions.get(req.params.sessionId);
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId.trim() : "";
  const applyApprovalId = typeof req.body?.applyApprovalId === "string" ? req.body.applyApprovalId.trim() : "";
  const message = typeof req.body?.message === "string" ? req.body.message : "";
  if (!entry || entry.ownerId !== userId) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  if (!proposalId || !entry.proposal || entry.proposal.proposalId !== proposalId) {
    res.status(400).json({ error: "Git commit requires the current Ruflo proposal.", code: "invalid_proposal" });
    return;
  }
  try {
    await stageProposal(proposalId, applyApprovalId);
    const result = await commitProposal(proposalId, approvalId, message);
    entry.git = { status: "committed", branch: result.branch };
    addPublicActivity(entry, {
      id: `${req.params.sessionId}-github-commit`,
      label: "GitHub",
      status: "complete",
      timestamp: new Date().toISOString(),
    });
    res.json(result);
  } catch (error) {
    entry.git = { status: "unavailable", branch: entry.git.branch };
    sendRufloGitError(res, error);
  }
});

router.post("/ruflo/sessions/:sessionId/git/push-review", async (req, res) => {
  const userId = req.authUser!.id;
  const entry = runtimeSessions.get(req.params.sessionId);
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  if (!entry || entry.ownerId !== userId) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  if (!proposalId || !entry.proposal || entry.proposal.proposalId !== proposalId) {
    res.status(400).json({ error: "Push review requires the current Ruflo proposal.", code: "invalid_proposal" });
    return;
  }
  try {
    const review = getPushReview(proposalId);
    const permission = await githubWriteProvider.checkRepositoryPermission(review.repository, review.branch);
    entry.git = { status: "ready", branch: review.branch };
    res.json({ ...review, permission });
  } catch (error) {
    sendRufloGitError(res, error);
  }
});

router.post("/ruflo/sessions/:sessionId/git/push", async (req, res) => {
  const userId = req.authUser!.id;
  const entry = runtimeSessions.get(req.params.sessionId);
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId.trim() : "";
  if (!entry || entry.ownerId !== userId) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  if (!proposalId || !entry.proposal || entry.proposal.proposalId !== proposalId) {
    res.status(400).json({ error: "Git push requires the current Ruflo proposal.", code: "invalid_proposal" });
    return;
  }
  try {
    const result = await pushProposal(proposalId, approvalId);
    const remote = await githubWriteProvider.getRepositoryState(result.repository, result.branch);
    assertRemoteHeadMatches(result.commitSha, remote.headSha);
    entry.git = { status: "pushed", branch: result.branch };
    addPublicActivity(entry, {
      id: `${req.params.sessionId}-github-push`,
      label: "GitHub",
      status: "complete",
      timestamp: new Date().toISOString(),
    });
    res.json({ ...result, verified: true, remoteHeadSha: remote.headSha });
  } catch (error) {
    entry.git = { status: "unavailable", branch: entry.git.branch };
    sendRufloGitError(res, error);
  }
});

router.get("/ruflo/sessions/:sessionId", async (req, res) => {
  const userId = req.authUser!.id;
  const entry = runtimeSessions.get(req.params.sessionId);
  if (entry) {
    if (entry.ownerId !== userId) {
      res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
      return;
    }
    res.json(publicSession(req.params.sessionId, entry));
    return;
  }

  const stored = await rufloSessionStore.getSession(userId, req.params.sessionId);
  if (!stored) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  const activities = await rufloSessionStore.listActivities(userId, stored.id);
  const activity: RufloPublicActivity[] = activities
    .map((item) => {
      const label = activityLabel(item.message);
      return label
        ? { id: item.id, label, status: item.kind === "failed" ? "failed" as const : "complete" as const, timestamp: item.createdAt.toISOString() } as RufloPublicActivity
        : undefined;
    })
    .filter((item): item is RufloPublicActivity => item !== undefined)
    .slice(-48);
  res.json({
    id: stored.id,
    mode: "ruflo",
    task: stored.goal,
    status: stored.status === "failed" ? "failed" : stored.status === "completed" ? "completed" : "waiting",
    phase: stored.status === "failed" ? "failed" : stored.status === "completed" ? "completed" : "waiting_approval",
    currentLabel: activity.at(-1)?.label ?? "Planning",
    currentAgent: stored.status === "completed" ? "Ruflo Manager" : "Human approval",
    activity,
    plan: [],
    affectedFiles: [],
    proposalStatus: "not-created",
    validationStatus: "not-run",
    git: { status: "not-available" },
    memoryFactCount: 0,
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
    recoveryAttempts: 0,
    maxRecoveryAttempts: MAX_RUFLO_RECOVERY_ATTEMPTS,
    agentExecutions: [],
    capability: "medium",
    routing: {
      primary: { provider: "unknown", model: "unknown" },
      fallbacks: [],
      reason: "Persisted session metadata is not available after the live runtime expires.",
    },
    usage: {
      sessionId: stored.id,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costStatus: "unknown",
      providerModels: [],
    },
    tasks: [],
    agents: [],
    executionWaves: [],
    memory: { factCount: 0, bounded: true, status: "empty" },
     specializedAgents: [],
     specializedProposals: [],
     jobs: [],
  } satisfies RufloPublicSession);
});

function publicSession(id: string, entry: RuntimeEntry): RufloPublicSession {
  const session = entry.session;
  const activity = entry.activity.slice(-24);
  const terminal = session?.status === "failed" || session?.status === "limit_reached";
  return {
    id,
    mode: "ruflo",
    task: session?.task ?? "Ruflo task",
    status: terminal || entry.error || entry.phase === "failed" ? "failed" : entry.phase === "completed" ? "completed" : entry.phase === "waiting_approval" ? "waiting" : "running",
    phase: entry.phase,
    currentLabel: activity.at(-1)?.label ?? "Planning",
    currentAgent: entry.currentAgent,
    activity,
    plan: session?.plan.steps.map((step) => step.title).slice(0, 6) ?? [],
    affectedFiles: (entry.proposal?.affectedFiles ?? session?.discoveredFiles ?? []).slice(0, 20),
    proposalStatus: entry.proposalStatus,
    validationStatus: entry.validation?.status ?? "not-run",
    git: entry.git,
    memoryFactCount: entry.memoryFactCount,
    proposal: entry.proposal,
    error: entry.error,
    recoveryAttempts: entry.recoveryAttempts,
    maxRecoveryAttempts: MAX_RUFLO_RECOVERY_ATTEMPTS,
    validation: entry.validation,
    workflowMessage: entry.workflowMessage,
    agentExecutions: entry.agentExecutions.map(publicAgentExecution),
    proposalAgent: entry.proposalAgent ? publicAgentExecution(entry.proposalAgent) : undefined,
    createdAt: entry.createdAt,
    updatedAt: session?.updatedAt ?? entry.createdAt,
    capability: entry.capability,
    routing: {
      primary: { provider: entry.routing.primary.provider.id, model: entry.routing.primary.model.id },
      fallbacks: entry.routing.fallbacks.map((candidate) => ({
        provider: candidate.provider.id,
        model: candidate.model.id,
      })),
      reason: entry.routing.reason,
    },
    usage: entry.costTracker.getSessionTotals(id),
    tasks: publicTasks(session),
    agents: publicAgents(entry),
    executionWaves: publicExecutionWaves(session),
    memory: { factCount: entry.memoryFactCount, bounded: true, status: entry.memoryFactCount ? "available" : "empty" },
    specializedAgents: entry.specializedAgents,
    specializedProposals: entry.specializedProposals,
    jobs: entry.jobs,
  };
}

type RufloLiveSnapshot = Omit<RufloPublicSession, "proposal">;

function publicLiveSession(session: RufloPublicSession): RufloLiveSnapshot {
  const { proposal: _proposal, ...snapshot } = session;
  return snapshot;
}

function publicTasks(session?: RufloSession): RufloPublicTask[] {
  return (session?.plan.steps ?? []).slice(0, 6).map((step, index) => ({
    id: step.id,
    title: step.title,
    status: step.status === "completed" ? "complete" : step.status === "active" ? "active" : "pending",
    dependencies: index > 0 ? [session!.plan.steps[index - 1]!.id] : [],
    wave: index,
    retryCount: 0,
  }));
}

function publicExecutionWaves(session?: RufloSession): RufloPublicSession["executionWaves"] {
  return publicTasks(session).map((task) => ({
    id: `wave-${task.wave + 1}`,
    label: `Wave ${task.wave + 1}`,
    taskIds: [task.id],
    status: task.status === "complete" ? "complete" : task.status === "active" ? "active" : "pending",
  }));
}

function publicAgents(entry: RuntimeEntry): RufloPublicAgent[] {
  const roles: RufloPublicSession["currentAgent"][] = [
    "Planner",
    "Coder",
    "Reviewer",
    "Validator",
    "Fixer",
    "Test Generator",
    "Documentation",
    "Git Intelligence",
    "Browser",
  ];
  return roles.map((role) => {
    const execution = entry.agentExecutions
      .filter((item) => agentRoleLabel(item.role) === role)
      .at(-1);
    return {
      id: role.toLowerCase(),
      role,
      status: execution
        ? execution.status === "failed" ? "failed" : "complete"
        : entry.currentAgent === role ? "active" : "idle",
      executionId: execution?.executionId,
      attempts: execution?.attempts,
    };
  });
}

function publishLive(
  sessionId: string,
  type: RufloLiveEventType,
  status: RufloLiveStatus,
  payload: Record<string, unknown> = {},
  taskId?: string,
): void {
  const entry = runtimeSessions.get(sessionId);
  const enrichedPayload = entry
    ? { ...payload, session: publicLiveSession(publicSession(sessionId, entry)) }
    : payload;
  rufloLiveEventHub.publish(sessionId, type, status, enrichedPayload, taskId);
}

function publishRuntimeEvents(entry: RuntimeEntry, session: RufloSession): void {
  for (const event of session.events) {
    if (entry.liveEventIds.has(event.id)) continue;
    entry.liveEventIds.add(event.id);
    const mapped: { type: RufloLiveEventType; status: RufloLiveStatus } =
      event.type === "tool_started"
        ? { type: "tool_started", status: "running" }
        : event.type === "tool_completed"
          ? { type: "tool_completed", status: "completed" }
          : event.type === "tool_failed"
            ? { type: "tool_failed", status: "failed" }
            : event.type === "proposal_ready"
              ? { type: "proposal_created", status: "waiting" }
              : event.type === "failed" || event.type === "limit_reached"
                ? { type: "session_failed", status: "failed" }
                : { type: "session_state", status: liveStatusForEntry(entry) };
    publishLive(session.id, mapped.type, mapped.status, {
      runtimeEvent: event.type,
      message: event.message,
      iteration: event.iteration,
      action: session.currentAction,
    });
  }
}

function publishPlanTaskEvents(entry: RuntimeEntry, session: RufloSession): void {
  for (const task of publicTasks(session)) {
    const previous = entry.taskStates.get(task.id);
    if (previous === task.status) continue;
    entry.taskStates.set(task.id, task.status);
    const type: RufloLiveEventType = task.status === "active"
      ? "task_running"
      : task.status === "complete"
        ? "task_completed"
        : "task_queued";
    publishLive(session.id, type, task.status === "complete" ? "completed" : task.status === "active" ? "running" : "queued", {
      title: task.title,
      dependencies: task.dependencies,
      wave: task.wave,
    }, task.id);
  }
}

function liveStatusForEntry(entry: RuntimeEntry): RufloLiveStatus {
  if (entry.error || entry.phase === "failed") return "failed";
  if (entry.phase === "completed") return "completed";
  if (entry.phase === "waiting_approval") return "waiting";
  return entry.phase === "inspecting" ? "running" : "active";
}

function publicAgentExecution(execution: RufloAgentExecution<unknown>): RufloPublicAgentExecution {
  return {
    executionId: execution.executionId,
    role: execution.role,
    status: execution.status,
    iteration: execution.iteration,
    attempts: execution.attempts,
    sourceExecutionIds: execution.input.sourceExecutionIds,
    completedAt: execution.completedAt,
  };
}

function updateWorkflowPhase(entry: RuntimeEntry, phase: RufloWorkflowPhase, userId: string, sessionId: string): void {
  entry.phase = phase;
  if (phase === "reviewing") entry.currentAgent = "Reviewer";
  if (phase === "validating") entry.currentAgent = "Validator";
  if (phase === "fixing") entry.currentAgent = "Fixer";
  if (phase === "waiting_approval") entry.currentAgent = "Human approval";
  if (phase === "completed" || phase === "failed") entry.currentAgent = "Ruflo Manager";
  const phaseEvents: Partial<Record<RufloWorkflowPhase, { type: RufloLiveEventType; status: RufloLiveStatus }>> = {
    reviewing: { type: "agent_started", status: "active" },
    validating: { type: "validation_started", status: "active" },
    fixing: { type: "recovery_started", status: "active" },
    waiting_approval: { type: "approval_requested", status: "waiting" },
    completed: { type: "validation_completed", status: "completed" },
    failed: { type: "validation_failed", status: "failed" },
  };
  const livePhaseEvent = phaseEvents[phase];
  if (livePhaseEvent) {
    publishLive(sessionId, livePhaseEvent.type, livePhaseEvent.status, { phase, agent: entry.currentAgent });
  }
  if (phase === "failed") {
    markLastActivityFailed(entry);
    return;
  }
  const labels: Partial<Record<RufloWorkflowPhase, RufloPublicActivity["label"]>> = {
    reviewing: "Reviewing",
    validating: "Validating",
    fixing: "Fixing",
    waiting_approval: "Waiting for Approval",
    completed: "Completed",
  };
  const label = labels[phase];
  if (!label) return;
  addPublicActivity(entry, {
    id: `${entry.createdAt}-${phase}-${entry.activity.length}`,
    label,
    status: phase === "completed" ? "complete" : "active",
    timestamp: new Date().toISOString(),
  });

  void persistActivity(userId, sessionId, entry.activity.at(-1));
}

router.get("/ruflo/sessions/:sessionId/events", async (req, res) => {
  const userId = req.authUser!.id;
  const sessionId = req.params.sessionId;
  const entry = runtimeSessions.get(sessionId);
  const requestedProjectId = optionalString(req.query.projectId);
  if (entry && !canReadRufloSession(userId, entry.ownerId, requestedProjectId, entry.projectId)) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  const stored = entry ? undefined : await rufloSessionStore.getSession(userId, sessionId);
  if (!entry && !stored) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }
  if (entry && entry.ownerId !== userId) {
    res.status(404).json({ error: "Ruflo session not found.", code: "not_found" });
    return;
  }

  const snapshot = entry
    ? publicLiveSession(publicSession(sessionId, entry))
    : publicLiveSession({
      id: stored!.id,
      mode: "ruflo",
      task: stored!.goal,
      status: stored!.status === "failed" ? "failed" : stored!.status === "completed" ? "completed" : "waiting",
      phase: stored!.status === "failed" ? "failed" : stored!.status === "completed" ? "completed" : "waiting_approval",
      currentLabel: "Planning",
      currentAgent: stored!.status === "completed" ? "Ruflo Manager" : "Human approval",
      activity: [],
      plan: [],
      affectedFiles: [],
      proposalStatus: "not-created",
      validationStatus: "not-run",
      git: { status: "not-available" },
      memoryFactCount: 0,
      createdAt: stored!.createdAt.toISOString(),
      updatedAt: stored!.updatedAt.toISOString(),
      recoveryAttempts: 0,
      maxRecoveryAttempts: MAX_RUFLO_RECOVERY_ATTEMPTS,
      agentExecutions: [],
      capability: "medium",
      routing: { primary: { provider: "unknown", model: "unknown" }, fallbacks: [], reason: "Persisted session metadata is not available after the live runtime expires." },
      usage: { sessionId, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costStatus: "unknown", providerModels: [] },
      tasks: [],
      agents: [],
      executionWaves: [],
      memory: { factCount: 0, bounded: true, status: "empty" },
      specializedAgents: [],
      specializedProposals: [],
      jobs: [],
    });

  const send = (event: import("../ruflo/ruflo-live-events").RufloLiveEvent) => {
    if (!res.writableEnded) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  let subscription: { unsubscribe: () => void } | undefined;
  try {
    const result = rufloLiveEventHub.subscribe(
      sessionId,
      typeof req.get("Last-Event-ID") === "string" ? req.get("Last-Event-ID") : undefined,
      snapshot,
      send,
    );
    subscription = result;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write("retry: 1500\n\n");
    for (const event of result.replay) send(event);
    if (!entry) {
      const terminalType = snapshot.status === "failed" ? "session_failed" : snapshot.status === "completed" ? "session_completed" : "session_state";
      const terminalStatus = snapshot.status === "failed" ? "failed" : snapshot.status === "completed" ? "completed" : "waiting";
      rufloLiveEventHub.publish(sessionId, terminalType, terminalStatus, { session: snapshot });
    }
  } catch (error) {
    res.status(429).json({ error: error instanceof Error ? error.message : "The Ruflo live event connection limit was reached.", code: "live_connection_limit" });
    return;
  }
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, 15_000);
  const close = () => {
    clearInterval(heartbeat);
    subscription?.unsubscribe();
  };
  req.on("close", close);
  res.on("close", close);
});

async function createRufloFixProposal(input: {
  entry: RuntimeEntry;
  diagnosis: string;
  attempt: number;
  provider: import("../ai/ai-provider").AiProvider;
  model: string;
  repository?: RepositoryRef;
  workspace?: { userId: string; projectId: string };
  ownerId: string;
}): Promise<ChangeProposal> {
  if (!input.entry.session) throw new Error("The Ruflo session is not available for recovery.");
  const source = input.entry.proposal;
  const fixSession: RufloSession = {
    ...input.entry.session,
    task: `${input.entry.session.task}\n\nDiagnose and fix the validation failure: ${input.diagnosis}`.slice(0, 2_000),
    selectedFiles: source?.affectedFiles ?? input.entry.session.selectedFiles,
    discoveredFiles: [...new Set([...(source?.affectedFiles ?? []), ...input.entry.session.discoveredFiles])],
    status: "proposal_ready",
    proposalReady: true,
  };
  return createRufloProposal({
    provider: input.provider,
    model: input.model,
    session: fixSession,
    repository: input.repository,
    ownerId: input.ownerId,
    workspace: input.workspace,
  });
}

function isRufloCapability(value: unknown): value is RufloCapabilityClass {
  return value === "light" || value === "medium" || value === "heavy";
}

function parseBudget(value: unknown): Partial<RufloBudgetLimits> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const numberValue = (key: keyof RufloBudgetLimits): number | undefined =>
    typeof input[key] === "number" && Number.isFinite(input[key]) ? input[key] as number : undefined;
  return {
    maxInputTokens: numberValue("maxInputTokens"),
    maxOutputTokens: numberValue("maxOutputTokens"),
    maxSessionTokens: numberValue("maxSessionTokens"),
    maxSessionCostUsd: numberValue("maxSessionCostUsd"),
    maxRequestCostUsd: numberValue("maxRequestCostUsd"),
    maxProviderRetries: numberValue("maxProviderRetries"),
  };
}

function parseMcpConfiguration(ownerId: string, value: unknown): {
  ownerId: string;
  serverName: string;
  scope: RufloMcpScope;
  transport: RufloMcpTransportConfiguration;
  enabled: boolean;
  allowedTools: string[];
  toolPolicies: Record<string, RufloMcpToolPolicy>;
  permissions: Array<"repository:read" | "workspace:read" | "mcp:read" | "mcp:write" | "network:outbound">;
  timeoutMs: number;
  autoApproveLowRisk: boolean;
} {
  if (!isRecord(value) || !isRecord(value.transport)) {
    throw new RufloMcpManagerError("invalid_configuration", "MCP server configuration is invalid.");
  }
  const transportValue = value.transport;
  let transport: RufloMcpTransportConfiguration;
  if (transportValue.type === "stdio" && typeof transportValue.command === "string" && Array.isArray(transportValue.args)) {
    transport = {
      type: "stdio",
      command: transportValue.command,
      args: transportValue.args.filter((item): item is string => typeof item === "string"),
    };
  } else if (transportValue.type === "streamable-http" && typeof transportValue.url === "string") {
    transport = { type: "streamable-http", url: transportValue.url };
  } else {
    throw new RufloMcpManagerError("invalid_configuration", "Only stdio and streamable HTTP MCP transports are supported.");
  }
  const scope: RufloMcpScope = isRecord(value.scope) && value.scope.type === "project" && typeof value.scope.projectId === "string"
    ? { type: "project", projectId: value.scope.projectId }
    : { type: "user" };
  const allowedTools = Array.isArray(value.allowedTools)
    ? value.allowedTools.filter((item): item is string => typeof item === "string")
    : [];
  const permissions = Array.isArray(value.permissions)
    ? value.permissions.filter(isMcpPermission)
    : ["mcp:read" as const];
  const toolPolicies: Record<string, RufloMcpToolPolicy> = {};
  if (isRecord(value.toolPolicies)) {
    for (const [name, rawPolicy] of Object.entries(value.toolPolicies)) {
      if (!isRecord(rawPolicy) || !isMcpRisk(rawPolicy.riskLevel) || !Array.isArray(rawPolicy.permissions)) continue;
      const policyPermissions = rawPolicy.permissions.filter(isMcpPermission);
      if (!policyPermissions.length) continue;
      toolPolicies[name] = {
        riskLevel: rawPolicy.riskLevel,
        permissions: policyPermissions,
        approvalRequired: rawPolicy.approvalRequired === true,
        outputSchema: isRecord(rawPolicy.outputSchema) ? rawPolicy.outputSchema as RufloMcpToolPolicy["outputSchema"] : undefined,
      };
    }
  }
  return {
    ownerId,
    serverName: typeof value.serverName === "string" ? value.serverName : "",
    scope,
    transport,
    enabled: value.enabled === true,
    allowedTools,
    toolPolicies,
    permissions,
    timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : 12_000,
    autoApproveLowRisk: value.autoApproveLowRisk === true,
  };
}

function publicMcpConfiguration(configuration: {
  serverName: string;
  scope: RufloMcpScope;
  transport: RufloMcpTransportConfiguration;
  enabled: boolean;
  allowedTools: string[];
  permissions: string[];
  timeoutMs: number;
  autoApproveLowRisk: boolean;
}): unknown {
  return {
    serverName: configuration.serverName,
    scope: configuration.scope,
    transport: configuration.transport,
    enabled: configuration.enabled,
    allowedTools: configuration.allowedTools,
    permissions: configuration.permissions,
    timeoutMs: configuration.timeoutMs,
    autoApproveLowRisk: configuration.autoApproveLowRisk,
  };
}

function publicMcpTool(tool: {
  id: string;
  name: string;
  description: string;
  source: string;
  serverName?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  permissions: string[];
  riskLevel: string;
  timeoutMs: number;
  enabled: boolean;
  approvalRequired: boolean;
}): unknown {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    source: tool.source,
    serverName: tool.serverName,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    permissions: tool.permissions,
    riskLevel: tool.riskLevel,
    timeoutMs: tool.timeoutMs,
    enabled: tool.enabled,
    approvalRequired: tool.approvalRequired,
  };
}

function sendMcpError(res: { status: (status: number) => { json: (value: unknown) => void } }, error: unknown): void {
  const code = error instanceof RufloMcpManagerError ? error.code : "invalid_configuration";
  const status = code === "session_unauthorized" ? 403 : code === "approval_required" ? 428 : code === "server_not_found" || code === "tool_not_found" ? 404 : 422;
  res.status(status).json({ error: error instanceof Error ? error.message.slice(0, 500) : "MCP request failed.", code });
}

function stringBody(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function optionalString(value: unknown): string | undefined {
  const parsed = stringBody(value);
  return parsed || undefined;
}

function isMcpPermission(value: unknown): value is "repository:read" | "workspace:read" | "mcp:read" | "mcp:write" | "network:outbound" {
  return ["repository:read", "workspace:read", "mcp:read", "mcp:write", "network:outbound"].includes(String(value));
}

function isMcpRisk(value: unknown): value is "READ_ONLY" | "LOW" | "MEDIUM" | "HIGH" | "DESTRUCTIVE" {
  return ["READ_ONLY", "LOW", "MEDIUM", "HIGH", "DESTRUCTIVE"].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activityForEvent(event: RufloEvent): RufloPublicActivity | undefined {
  const label = activityLabel(event.message, event.type);
  if (!label) return undefined;
  return {
    id: event.id,
    label,
    status: event.type === "failed" || event.type === "tool_failed"
      ? "failed"
      : event.type === "tool_completed" || event.type === "planned"
        ? "complete"
        : "active",
    timestamp: event.timestamp,
  };
}

function activityLabel(message: string, type?: RufloEvent["type"]): RufloPublicActivity["label"] | undefined {
  const lower = message.toLowerCase();
  if (type === "planned" || lower.includes("plan")) return "Planning";
  if (lower.includes("read_file") || lower.includes("read file")) return "Reading Files";
  if (lower.includes("inspect")) return "Inspecting Project";
  if (lower.includes("search")) return "Searching Files";
  return undefined;
}

function agentActivityLabel(role: RufloAgentExecution<unknown>["role"]): RufloPublicActivity["label"] {
  const labels: Record<RufloAgentExecution<unknown>["role"], RufloPublicActivity["label"]> = {
    planner: "Delegating",
    coder: "Coding",
    reviewer: "Reviewing",
    validator: "Validating",
    fixer: "Fixing",
    test_generator: "Testing",
    documentation: "Documentation",
    git_intelligence: "Git Intelligence",
    browser: "Browser",
  };
  return labels[role];
}

function addPublicActivity(entry: RuntimeEntry, activity: RufloPublicActivity): void {
  const previous = entry.activity.at(-1);
  if (previous?.label === activity.label && previous.status === activity.status) return;
  if (previous?.label === activity.label && previous.status === "active" && activity.status === "complete") {
    entry.activity[entry.activity.length - 1] = activity;
    return;
  }
  entry.activity = [...entry.activity, activity].slice(-48);
}

function agentRoleLabel(role: RufloAgentExecution<unknown>["role"]): Exclude<RufloPublicSession["currentAgent"], "Ruflo Manager" | "Human approval"> {
  const labels: Record<RufloAgentExecution<unknown>["role"], Exclude<RufloPublicSession["currentAgent"], "Ruflo Manager" | "Human approval">> = {
    planner: "Planner",
    coder: "Coder",
    reviewer: "Reviewer",
    validator: "Validator",
    fixer: "Fixer",
    test_generator: "Test Generator",
    documentation: "Documentation",
    git_intelligence: "Git Intelligence",
    browser: "Browser",
  };
  return labels[role];
}

function markLastActivityFailed(entry: RuntimeEntry): void {
  const previous = entry.activity.at(-1);
  if (!previous || previous.status === "failed") return;
  entry.activity[entry.activity.length - 1] = { ...previous, status: "failed", timestamp: new Date().toISOString() };
}

async function persistActivity(userId: string, sessionId: string, activity: RufloPublicActivity | undefined): Promise<void> {
  if (!activity) return;
  await rufloSessionStore.createActivity(userId, {
    sessionId,
    kind: activity.status === "failed" ? "failed" : activity.label.toLowerCase().replaceAll(" ", "_"),
    message: activity.label,
  }).catch(() => undefined);
}

async function rememberRufloSessionFacts(
  userId: string,
  projectKey: string,
  session: RufloSession,
): Promise<void> {
  const inspection = session.observations.find((item) => item.tool === "inspect_repository" && item.status === "completed");
  const result = inspection?.result;
  const facts: Array<{ kind: RufloMemoryKind; fact: string; confidence: number; importance: number }> = [];
  if (result && typeof result === "object") {
    const data = result as Record<string, unknown>;
    const technology = [stringValue(data.language), stringValue(data.framework), stringValue(data.packageManager)].filter(Boolean);
    if (technology.length) facts.push({
      kind: "project_fact",
      fact: `Project technology: ${technology.join(" · ")}`,
      confidence: 0.75,
      importance: 65,
    });
    if (Array.isArray(data.architecture)) {
      for (const item of data.architecture.slice(0, 4)) {
        const fact = typeof item === "string" ? item : item && typeof item === "object" && "description" in item && typeof item.description === "string" ? item.description : "";
        if (fact.trim()) facts.push({
          kind: "architecture_decision",
          fact: `Observed architecture pattern: ${fact}`,
          confidence: 0.65,
          importance: 60,
        });
      }
    }
  }
  await Promise.allSettled(facts.map((fact) => rufloMemoryStore.remember(userId, {
    projectKey,
    sourceSessionId: session.id,
    ...fact,
  })));
}

async function rememberRufloOutcome(
  userId: string,
  entry: RuntimeEntry,
  workflow: { status: "completed" | "waiting_approval" | "failed"; validation?: { status: "pass" | "fail" | "not-verified"; summary: string } },
): Promise<void> {
  const candidates = extractRufloLearning({
    session: entry.session,
    proposal: entry.proposal,
    workflowStatus: workflow.status,
    validation: workflow.validation,
  });
  await Promise.allSettled(candidates.map((candidate) => rufloMemoryStore.remember(userId, {
    projectKey: entry.projectKey,
    sourceSessionId: entry.session?.id,
    kind: candidate.kind,
    fact: candidate.fact,
    confidence: candidate.confidence,
    importance: candidate.importance,
    outcome: candidate.outcome,
  })));
  await rufloMemoryStore.cleanup(userId, entry.projectKey).catch(() => undefined);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 180) : "";
}

async function inspectForSpecializedAgent(
  entry: RuntimeEntry,
  request: RufloSpecializedInspectRequest,
  userId: string,
): Promise<RufloSpecializedInspection> {
  const requested = [...new Set(request.selectedFiles)].slice(0, request.maxFiles);
  const files: RufloSpecializedInspectionFile[] = [];
  if (entry.repository) {
    const overview = await getRepositoryOverview(entry.repository);
    const candidates = overview.files
      .filter((file) => requested.length === 0 || requested.includes(file.path))
      .filter((file) => request.include.includes(categoryToInspectionKind(file.category)))
      .slice(0, request.maxFiles);
    const results = await Promise.allSettled(candidates.map((file) => readRepositoryFile(entry.repository!, file.path)));
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const file = candidates[index]!;
      files.push({
        path: result.value.path,
        kind: categoryToInspectionKind(file.category),
        content: result.value.content.slice(0, 12_000),
      });
    });
    return {
      files,
      projectStructure: overview.directories.slice(0, 80).join("\n"),
      apiBehavior: overview.apiFiles.slice(0, 40).join("\n"),
      references: [entry.repository.webUrl, ...overview.entryPoints.slice(0, 20)],
    };
  }

  const inspection = await inspectWorkspace(userId, entry.projectId, requested, request.task);
  const candidates = [...new Set([...requested, ...inspection.relevantFiles])].slice(0, request.maxFiles);
  const results = await Promise.allSettled(candidates.map((path) => readWorkspaceFile(userId, entry.projectId, path)));
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const path = result.value.path;
    const kind = workspacePathKind(path);
    if (request.include.includes(kind)) files.push({ path, kind, content: result.value.content.slice(0, 12_000) });
  });
  return {
    files,
    projectStructure: inspection.structure.slice(0, 100).map((file) => file.path).join("\n"),
    references: inspection.entryPoints.slice(0, 20),
  };
}

function categoryToInspectionKind(category: RepositoryFileCategory): RufloSpecializedInspectionFile["kind"] {
  if (category === "test") return "test";
  if (category === "documentation") return "documentation";
  if (category === "configuration" || category === "package") return "configuration";
  return "source";
}

function workspacePathKind(path: string): RufloSpecializedInspectionFile["kind"] {
  if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return "test";
  if (/(^|\/)(readme|docs?|documentation)(\/|\.|$)/i.test(path) || /\.(md|mdx|txt)$/i.test(path)) return "documentation";
  if (/(package\.json|tsconfig|vite\.config|drizzle\.config|\.config\.)/i.test(path)) return "configuration";
  return "source";
}

function isBrowserAction(value: unknown): value is RufloBrowserAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  return (action.type === "click" || action.type === "fill" || action.type === "press")
    && (action.selector === undefined || typeof action.selector === "string")
    && (action.value === undefined || typeof action.value === "string");
}

function parseRepository(value: unknown): RepositoryRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const fields = ["id", "owner", "name", "branch", "defaultBranch", "webUrl"];
  if (!fields.every((field) => typeof candidate[field] === "string" && String(candidate[field]).trim())) return undefined;
  if (typeof candidate.webUrl !== "string" || !candidate.webUrl.startsWith("https://github.com/")) return undefined;
  return {
    id: String(candidate.id).slice(0, 200),
    owner: String(candidate.owner).slice(0, 100),
    name: String(candidate.name).slice(0, 100),
    branch: String(candidate.branch).slice(0, 200),
    defaultBranch: String(candidate.defaultBranch).slice(0, 200),
    webUrl: String(candidate.webUrl).slice(0, 500),
  };
}

function publicError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Ruflo could not start this session.";
}

function publicSwarmAgent(agent: RufloAgent): Omit<RufloAgent, "credentialNonce"> {
  const { credentialNonce: _credentialNonce, ...publicAgent } = agent;
  return publicAgent;
}

function publicSwarmMessage(message: RufloSwarmMessage): RufloSwarmMessage {
  return { ...message, payload: message.payload };
}

function publicConsensus(consensus: RufloConsensus): RufloConsensus {
  return { ...consensus, votes: consensus.votes.map((vote) => ({ ...vote, value: vote.value })) };
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function numberQuery(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sendRufloSwarmError(
  res: { status: (code: number) => { json: (value: unknown) => void } },
  error: unknown,
): void {
  if (error instanceof RufloSwarmError) {
    const status = error.code === "not_found" || error.code === "recipient_not_found" || error.code === "message_not_found" || error.code === "task_not_found"
      ? 404
      : error.code === "agent_unauthorized" || error.code === "capability_denied" || error.code === "lease_expired" || error.code === "lease_owner"
        ? 403
        : error.code === "context_conflict" || error.code === "lease_taken" || error.code === "topology"
          ? 409
          : error.code === "configuration" ? 503 : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(400).json({ error: publicError(error), code: "swarm_request_failed" });
}

function proposalError(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error instanceof Error) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "proposal_failure",
    message: error instanceof Error ? error.message : "The Ruflo proposal could not be generated.",
  };
}

function sendRufloGitError(res: { status: (code: number) => { json: (value: unknown) => void } }, error: unknown): void {
  if (error instanceof GitHubWriteProviderError) {
    const status = error.code === "permission_denied" ? 403 : error.code === "conflict" ? 409 : error.code === "invalid_state" ? 400 : 503;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "git_operation_failed";
  const status = code === "stale_file" ? 409 : code === "protected_file" || code === "unsafe_path" ? 403 : 400;
  res.status(status).json({ error: publicError(error), code });
}

export default router;