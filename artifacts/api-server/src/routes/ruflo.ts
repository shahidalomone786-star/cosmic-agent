import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { providerManager } from "../ai/provider-manager";
import { createRufloToolExecutor, runRufloSession, type RufloEvent, type RufloSession } from "../ruflo/ruflo-runtime";
import { rufloSessionStore } from "../ruflo/database-session-store";
import type { RepositoryRef } from "../repository/github-provider";
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
import { runRufloPreparationAgents, type RufloAgentExecution, type RufloProposalOutput } from "../ruflo/ruflo-agents";
import { assertRemoteHeadMatches, GitHubWriteProviderError, githubWriteProvider } from "../repository/github-write-provider";
import { formatMemoryContext, projectMemoryKey, rufloMemoryStore } from "../ruflo/memory-store";
import { extractRufloLearning } from "../ruflo/memory-learning";
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
  RufloMcpManager,
  RufloMcpManagerError,
  type RufloMcpScope,
  type RufloMcpToolPolicy,
} from "../ruflo/ruflo-mcp-manager";
import type { RufloMcpTransportConfiguration } from "../ruflo/ruflo-mcp-client";

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
  currentAgent: "Ruflo Manager" | "Planner" | "Coder" | "Reviewer" | "Validator" | "Fixer" | "Human approval";
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
};

type RufloPublicAgentExecution = {
  executionId: string;
  role: "planner" | "coder" | "reviewer" | "validator" | "fixer";
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
};

const router: IRouter = Router();
const runtimeSessions = new Map<string, RuntimeEntry>();
const persistedEvents = new Map<string, Set<string>>();
const rufloExecutionLocks = new Set<string>();
const rufloModelRouter = new RufloModelRouter(providerManager.getProviders());
const rufloToolRegistry = createDefaultRufloToolRegistry();
const rufloMcpManager = new RufloMcpManager({
  registry: rufloToolRegistry,
  isSessionOwned: (userId, sessionId) => runtimeSessions.get(sessionId)?.ownerId === userId,
});

router.use((req, res, next) => requireAuthenticatedUser(req, res) ? next() : undefined);

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
    };
    runtimeSessions.set(stored.id, entry);
    persistedEvents.set(stored.id, new Set());
    await rufloSessionStore.updateSessionStatus(userId, stored.id, "active");
    await rufloSessionStore.createActivity(userId, {
      sessionId: stored.id,
      kind: "planning",
      message: "Planning",
    });

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
        } catch (error) {
          current.error = proposalError(error);
          markLastActivityFailed(current);
          logger.error({ err: error, sessionId: session.id }, "Ruflo proposal generation failed");
        }
      }
      await rememberRufloSessionFacts(userId, projectKey, session);
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
      }
      await rufloSessionStore.updateSessionStatus(userId, stored.id, "failed").catch(() => undefined);
    });

    res.status(201).json(publicSession(stored.id, entry));
  } catch (error) {
    res.status(400).json({ error: publicError(error), code: "ruflo_start_failed" });
  }
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
    } else if (workflow.status === "failed") {
      entry.error = { code: "workflow_failed", message: workflow.message };
      await rufloSessionStore.updateSessionStatus(userId, req.params.sessionId, "failed");
    } else {
      await rufloSessionStore.updateSessionStatus(userId, req.params.sessionId, "active");
    }
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
  };
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