import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { providerManager } from "../ai/provider-manager";
import { runRufloSession, type RufloEvent, type RufloSession } from "../ruflo/ruflo-runtime";
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
import type { RufloMemory, RufloMemoryKind } from "../ruflo/types";

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
};

const router: IRouter = Router();
const runtimeSessions = new Map<string, RuntimeEntry>();
const persistedEvents = new Map<string, Set<string>>();
const rufloExecutionLocks = new Set<string>();

router.use((req, res, next) => requireAuthenticatedUser(req, res) ? next() : undefined);

router.post("/ruflo/sessions", async (req, res) => {
  const userId = req.authUser!.id;
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  const projectId = typeof req.body?.projectId === "string" && req.body.projectId.trim()
    ? req.body.projectId.trim().slice(0, 80)
    : "default";
  const repository = parseRepository(req.body?.repository);
  const selectedFiles = Array.isArray(req.body?.selectedFiles)
    ? req.body.selectedFiles.filter((item: unknown): item is string => typeof item === "string").slice(0, 20)
    : [];

  if (!task || !model) {
    res.status(400).json({ error: "Describe the task and select an approved model.", code: "invalid_request" });
    return;
  }

  try {
    const provider = providerManager.getProviderForModel(model);
    const projectKey = projectMemoryKey({ projectId, repository });
    let memory: RufloMemory[] = [];
    try {
      memory = await rufloMemoryStore.listMemory(userId, projectKey);
    } catch (error) {
      logger.warn({ err: error, userId, projectKey }, "Ruflo memory retrieval skipped");
    }
    const stored = await rufloSessionStore.createSession(userId, { goal: task });
    const createdAt = stored.createdAt.toISOString();
    const initialActivity: RufloPublicActivity = {
      id: `${stored.id}-planning`,
      label: "Planning",
      status: "active",
      timestamp: createdAt,
    };
    const entry: RuntimeEntry = {
      ownerId: userId,
      model,
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
      model,
      provider,
      repository,
      workspace: repository ? undefined : { userId, projectId },
      selectedFiles,
      memoryContext: formatMemoryContext(memory),
      onUpdate: (session) => {
        const current = runtimeSessions.get(session.id);
        if (!current) return;
        current.session = session;
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
              model,
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
          providerManager.getProvider(registered.provider ?? "groq"),
          proposal.proposalId,
        );
        return { status: result.status, summary: result.summary };
      },
      rollback: () => rejectAppliedProposal(proposalId),
      createFixProposal: (diagnosis, attempt) => createRufloFixProposal({
        entry,
        diagnosis,
        attempt,
        providerId: registered.provider ?? "groq",
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
  providerId: "groq" | "gemini";
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
    provider: providerManager.getProvider(input.providerId),
    model: input.model,
    session: fixSession,
    repository: input.repository,
    ownerId: input.ownerId,
    workspace: input.workspace,
  });
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
  const facts: Array<{ kind: RufloMemoryKind; fact: string }> = [];
  if (result && typeof result === "object") {
    const data = result as Record<string, unknown>;
    const technology = [stringValue(data.language), stringValue(data.framework), stringValue(data.packageManager)].filter(Boolean);
    if (technology.length) facts.push({ kind: "technology", fact: `Project technology: ${technology.join(" · ")}` });
    if (Array.isArray(data.architecture)) {
      for (const item of data.architecture.slice(0, 4)) {
        const fact = typeof item === "string" ? item : item && typeof item === "object" && "description" in item && typeof item.description === "string" ? item.description : "";
        if (fact.trim()) facts.push({ kind: "architecture", fact: `Architecture pattern: ${fact}` });
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
  const facts: Array<{ kind: RufloMemoryKind; fact: string }> = [];
  if (workflow.status === "completed" && entry.proposal?.summary) {
    facts.push({ kind: "success", fact: `Successful task: ${entry.proposal.summary}` });
  }
  if (workflow.validation && workflow.validation.status !== "pass") {
    facts.push({ kind: "validation_problem", fact: `Recurring validation problem: ${workflow.validation.summary}` });
  }
  await Promise.allSettled(facts.map((fact) => rufloMemoryStore.remember(userId, {
    projectKey: entry.projectKey,
    sourceSessionId: entry.session?.id,
    ...fact,
  })));
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