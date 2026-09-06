import { randomUUID } from "node:crypto";
import type { RufloSession } from "./ruflo-runtime";
import type { RufloAgentRole } from "./ruflo-agents";
import {
  RufloDynamicDagScheduler,
  type RufloSwarmTask,
  type RufloTaskOperation,
  type RufloSwarmLimits,
} from "./ruflo-dag";
import type { RufloToolRegistry, RufloUnifiedToolDefinition } from "./ruflo-tool-registry";
import type { RufloRoutingDecision, RufloProviderAttempt } from "./ruflo-provider-router";
import type { RufloSessionStore } from "./session-store";

export const PHASE12_VERSION = "12";
export const PHASE12_MAX_NODES = 32;
export const PHASE12_MAX_AGENTS = 8;
export const PHASE12_MAX_TOOLS = 24;
export const PHASE12_MAX_RETRIES = 3;
export const PHASE12_MAX_TIMEOUT_MS = 300_000;
export const PHASE12_MAX_INPUT_BYTES = 16_000;
export const PHASE12_MAX_OUTPUT_BYTES = 32_000;
export const PHASE12_MAX_CHECKPOINT_BYTES = 48_000;

export type Phase12FailureCategory =
  | "VALIDATION"
  | "AUTHORIZATION"
  | "CAPABILITY"
  | "TOOL"
  | "TIMEOUT"
  | "RESOURCE"
  | "NETWORK"
  | "PROVIDER"
  | "DEPENDENCY"
  | "WORKSPACE"
  | "AGENT"
  | "WORKFLOW"
  | "UNKNOWN";

export type Phase12NodeState =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "RETRYING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "BLOCKED"
  | "WAITING_APPROVAL";

export type Phase12AgentRole =
  | "planner"
  | "researcher"
  | "coder"
  | "tester"
  | "reviewer"
  | "security"
  | "docs";

export type Phase12Agent = {
  id: string;
  role: Phase12AgentRole;
  identity: string;
  capabilities: string[];
  allowedTools: string[];
  status: "IDLE" | "LEASED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  lease: { owner: string; heartbeatAt: string; expiresAt: string } | null;
  cancellationRequested: boolean;
};

export type Phase12Node = {
  id: string;
  task: string;
  agent: string;
  toolDependencies: string[];
  dependencies: string[];
  boundedIO: { maxInputBytes: number; maxOutputBytes: number };
  state: Phase12NodeState;
  retries: number;
  maxRetries: number;
  timeoutMs: number;
  checkpointId?: string;
  approvalRequired: boolean;
};

export type Phase12Plan = {
  version: typeof PHASE12_VERSION;
  taskId: string;
  sessionId: string;
  userId: string;
  workspace: { projectId: string; repository?: string };
  interpretation: string;
  assumptions: string[];
  capabilities: string[];
  agents: Phase12Agent[];
  tools: string[];
  nodes: Phase12Node[];
  dependencies: Array<{ nodeId: string; dependsOn: string[] }>;
  outputs: string[];
  risk: { level: "LOW" | "MEDIUM" | "HIGH"; reasons: string[] };
  approvalNeeds: string[];
  budgets: {
    maxNodes: number;
    maxParallelism: number;
    maxRetries: number;
    maxRuntimeMs: number;
    maxInputBytes: number;
    maxOutputBytes: number;
  };
  recoveryStrategy: {
    retryable: Phase12FailureCategory[];
    stopOn: Phase12FailureCategory[];
    strategy: "bounded_retry_then_stop";
  };
  evidence: {
    discoveredFiles: string[];
    memoryFacts: number;
    contextBounded: boolean;
  };
};

export type Phase12PlanInput = {
  taskId?: string;
  session: RufloSession;
  userId: string;
  projectId: string;
  repository?: { owner: string; name: string; branch: string };
  memoryFacts?: number;
  registry: RufloToolRegistry;
};

export type Phase12DagResult = {
  status: "completed" | "failed" | "cancelled" | "waiting_approval";
  nodes: Phase12Node[];
  outputs: Record<string, unknown>;
  failures: Phase12Diagnostic[];
};

export type Phase12Diagnostic = {
  category: Phase12FailureCategory;
  message: string;
  nodeId?: string;
  agentId?: string;
  toolId?: string;
  stack?: string;
  file?: string;
  line?: number;
  requestId?: string;
  response?: string;
  rootCause: string;
  retryable: boolean;
};

export type Phase12ProviderTrace = {
  sessionId: string;
  capability: string;
  provider: string;
  model: string;
  reason: string;
  fallbackUsed: boolean;
  classification?: string;
};

export type Phase12AuthorityAction = "read" | "inspect" | "validate" | "propose" | "apply" | "commit" | "push" | "approve";

export type Phase12MemoryScope = {
  userId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
};

export type Phase12Experience = {
  id: string;
  scope: Phase12MemoryScope;
  pattern: string;
  provenance: string;
  confidence: number;
  expiresAt: string;
};

export type Phase12MetricsSnapshot = {
  sessions: number;
  plans: number;
  nodes: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  retries: number;
  approvals: number;
  providerAttempts: number;
  recoveryAttempts: number;
};

export class Phase12Error extends Error {
  constructor(
    readonly code:
      | "invalid_plan"
      | "cycle"
      | "recursive_instruction"
      | "resource_limit"
      | "approval_required"
      | "ownership"
      | "checkpoint_invalid",
    message: string,
  ) {
    super(message);
    this.name = "Phase12Error";
  }
}

export function assertPhase12Authority(action: Phase12AuthorityAction): void {
  if (action === "apply" || action === "commit" || action === "push" || action === "approve") {
    throw new Phase12Error("approval_required", `Phase 12 cannot ${action}; Cosmic approval and the existing server-owned workflow are required.`);
  }
}

const PHASE12_ROLE_CAPABILITIES: Record<Phase12AgentRole, { capabilities: string[]; tools: string[] }> = {
  planner: { capabilities: ["interpret_task", "build_plan", "estimate_resources"], tools: ["inspect_repository", "repository_search", "read_file"] },
  researcher: { capabilities: ["inspect_repository", "retrieve_memory", "summarize_evidence"], tools: ["inspect_repository", "repository_search", "read_file"] },
  coder: { capabilities: ["prepare_proposal", "read_context"], tools: ["inspect_repository", "repository_search", "read_file"] },
  tester: { capabilities: ["inspect_validation", "bounded_test_analysis"], tools: ["workflow_validate", "system_health", "read_file"] },
  reviewer: { capabilities: ["review_evidence", "assess_risk"], tools: ["inspect_repository", "repository_search", "read_file", "system_health"] },
  security: { capabilities: ["security_review", "redaction_review"], tools: ["system_health", "system_metrics", "read_file"] },
  docs: { capabilities: ["documentation_analysis", "prepare_documentation_proposal"], tools: ["inspect_repository", "repository_search", "read_file"] },
};

const RETRYABLE_FAILURES = new Set<Phase12FailureCategory>([
  "TOOL", "TIMEOUT", "RESOURCE", "NETWORK", "PROVIDER", "DEPENDENCY", "AGENT", "WORKFLOW",
]);

const NEVER_RETRY = new Set<Phase12FailureCategory>(["VALIDATION", "AUTHORIZATION", "CAPABILITY", "WORKSPACE"]);

export function createPhase12Agents(
  roles: readonly Phase12AgentRole[],
  now = new Date(),
): Phase12Agent[] {
  const uniqueRoles = [...new Set(roles)].slice(0, PHASE12_MAX_AGENTS);
  return uniqueRoles.map((role) => {
    const definition = PHASE12_ROLE_CAPABILITIES[role];
    const leaseNow = new Date(now).toISOString();
    return {
      id: `phase12-${role}-${randomUUID().slice(0, 8)}`,
      role,
      identity: `phase12:${role}`,
      capabilities: [...definition.capabilities],
      allowedTools: [...definition.tools],
      status: "IDLE",
      lease: null,
      cancellationRequested: false,
    };
  });
}

export function acquirePhase12Lease(
  agent: Phase12Agent,
  owner: string,
  now = new Date(),
  ttlMs = 30_000,
): Phase12Agent {
  if (!owner.trim()) throw new Phase12Error("ownership", "A Phase 12 lease requires an authenticated owner.");
  if (agent.lease && new Date(agent.lease.expiresAt).getTime() > now.getTime() && agent.lease.owner !== owner) {
    throw new Phase12Error("ownership", `Phase 12 agent ${agent.id} is leased by another owner.`);
  }
  const heartbeatAt = new Date(now).toISOString();
  return {
    ...agent,
    status: "LEASED",
    lease: { owner: owner.slice(0, 120), heartbeatAt, expiresAt: new Date(now.getTime() + Math.max(1_000, Math.min(ttlMs, 120_000))).toISOString() },
    cancellationRequested: false,
  };
}

export function heartbeatPhase12Lease(agent: Phase12Agent, owner: string, now = new Date(), ttlMs = 30_000): Phase12Agent {
  if (!agent.lease || agent.lease.owner !== owner || new Date(agent.lease.expiresAt).getTime() <= now.getTime()) {
    throw new Phase12Error("ownership", `Phase 12 agent ${agent.id} does not have an active lease for this owner.`);
  }
  return acquirePhase12Lease(agent, owner, now, ttlMs);
}

export function requestPhase12Cancellation(agent: Phase12Agent, owner: string): Phase12Agent {
  if (!agent.lease || agent.lease.owner !== owner) throw new Phase12Error("ownership", `Phase 12 agent ${agent.id} is not owned by this requester.`);
  return { ...agent, cancellationRequested: true, status: "CANCELLED" };
}

export function selectPhase12Tools(
  registry: RufloToolRegistry,
  requested: readonly string[],
): RufloUnifiedToolDefinition[] {
  const selected: RufloUnifiedToolDefinition[] = [];
  for (const id of [...new Set(requested)].slice(0, PHASE12_MAX_TOOLS)) {
    if (!registry.has(id)) continue;
    const tool = registry.get(id);
    if (!tool.enabled || tool.availability === "disabled" || tool.implementationKind === "disabled" || tool.implementationKind === "metadata-only") continue;
    if (!tool.agentAccess?.rufloOnly) continue;
    selected.push(tool);
  }
  return selected;
}

export function buildPhase12Plan(input: Phase12PlanInput): Phase12Plan {
  const session = input.session;
  if (!input.registry) throw new Phase12Error("invalid_plan", "A Phase 12 plan requires the server-owned Ruflo tool registry.");
  const taskId = (input.taskId ?? `task-${session.id}`).slice(0, 120);
  const steps = session.plan.steps.slice(0, PHASE12_MAX_NODES);
  if (!steps.length || !session.context.trim() || !session.discoveredFiles.length) {
    throw new Phase12Error("invalid_plan", "A Phase 12 plan requires a completed bounded Ruflo inspection with repository evidence.");
  }
  const selectedRoles: Phase12AgentRole[] = [
    "planner",
    "researcher",
    "coder",
    ...(session.plan.specializedAgents?.includes("test_generator") ? ["tester" as const] : []),
    ...(session.plan.specializedAgents?.includes("documentation") ? ["docs" as const] : []),
    "reviewer",
  ];
  const agents = createPhase12Agents(selectedRoles);
  const agentByRole = new Map(agents.map((agent) => [agent.role, agent.id]));
  const nodes = steps.map((step, index): Phase12Node => ({
    id: step.id.slice(0, 80),
    task: step.description.slice(0, 2_000),
    agent: agentByRole.get(index === 0 ? "planner" : index === 1 ? "researcher" : "coder") ?? agents[0].id,
    toolDependencies: index === 0 ? ["inspect_repository"] : ["read_file"],
    dependencies: index === 0 ? [] : [steps[index - 1].id.slice(0, 80)],
    boundedIO: { maxInputBytes: PHASE12_MAX_INPUT_BYTES, maxOutputBytes: PHASE12_MAX_OUTPUT_BYTES },
    state: index === 0 ? "READY" : "PENDING",
    retries: 0,
    maxRetries: 1,
    timeoutMs: 45_000,
    approvalRequired: false,
  }));
  const tools = selectPhase12Tools(input.registry, nodes.flatMap((node) => node.toolDependencies)).map((tool) => tool.id);
  const plan: Phase12Plan = {
    version: PHASE12_VERSION,
    taskId,
    sessionId: session.id,
    userId: input.userId,
    workspace: {
      projectId: input.projectId.slice(0, 120),
      repository: input.repository ? `${input.repository.owner}/${input.repository.name}#${input.repository.branch}`.slice(0, 300) : undefined,
    },
    interpretation: session.plan.goal.slice(0, 2_000),
    assumptions: [
      "Repository/workspace evidence is bounded and server-authorized.",
      "Any repository mutation remains a proposal and explicit Cosmic approval concern.",
    ],
    capabilities: [session.capability ?? "medium", "bounded_inspection", "proposal_only_mutation"],
    agents,
    tools,
    nodes,
    dependencies: nodes.map((node) => ({ nodeId: node.id, dependsOn: [...node.dependencies] })),
    outputs: ["bounded_evidence", "execution_observations", "proposal_or_stop_reason"],
    risk: {
      level: "MEDIUM",
      reasons: ["The plan can prepare evidence for a proposal but cannot apply, commit, push, or approve changes."],
    },
    approvalNeeds: ["proposal review before any repository mutation", "separate apply, commit, and push approvals"],
    budgets: {
      maxNodes: PHASE12_MAX_NODES,
      maxParallelism: 3,
      maxRetries: 1,
      maxRuntimeMs: 120_000,
      maxInputBytes: PHASE12_MAX_INPUT_BYTES,
      maxOutputBytes: PHASE12_MAX_OUTPUT_BYTES,
    },
    recoveryStrategy: {
      retryable: [...RETRYABLE_FAILURES],
      stopOn: [...NEVER_RETRY],
      strategy: "bounded_retry_then_stop",
    },
    evidence: {
      discoveredFiles: [...new Set(session.discoveredFiles)].slice(0, 20),
      memoryFacts: Math.max(0, Math.min(input.memoryFacts ?? 0, 24)),
      contextBounded: session.context.length <= 32_000,
    },
  };
  validatePhase12Plan(plan);
  return plan;
}

export function validatePhase12Plan(plan: Phase12Plan): void {
  if (plan.version !== PHASE12_VERSION || !plan.taskId || !plan.sessionId || !plan.userId) {
    throw new Phase12Error("invalid_plan", "Phase 12 plans require bounded task, session, and user identity.");
  }
  if (plan.nodes.length === 0 || plan.nodes.length > PHASE12_MAX_NODES) {
    throw new Phase12Error("resource_limit", `Phase 12 allows at most ${PHASE12_MAX_NODES} DAG nodes.`);
  }
  if (plan.agents.length === 0 || plan.agents.length > PHASE12_MAX_AGENTS) {
    throw new Phase12Error("resource_limit", `Phase 12 allows at most ${PHASE12_MAX_AGENTS} agents.`);
  }
  validatePhase12Dag(plan.nodes);
  const agentIds = new Set(plan.agents.map((agent) => agent.id));
  const toolIds = new Set(plan.tools);
  for (const node of plan.nodes) {
    if (!agentIds.has(node.agent)) throw new Phase12Error("invalid_plan", `Node ${node.id} references an unknown agent.`);
    if (node.toolDependencies.some((tool) => !toolIds.has(tool))) throw new Phase12Error("invalid_plan", `Node ${node.id} references an unselected tool.`);
  }
  for (const agent of plan.agents) {
    if (new Set(agent.capabilities).size !== agent.capabilities.length || new Set(agent.allowedTools).size !== agent.allowedTools.length) {
      throw new Phase12Error("invalid_plan", `Agent ${agent.id} has duplicated capability declarations.`);
    }
  }
}

export function validatePhase12Dag(nodes: readonly Phase12Node[]): void {
  if (nodes.length > PHASE12_MAX_NODES) throw new Phase12Error("resource_limit", `Phase 12 allows at most ${PHASE12_MAX_NODES} DAG nodes.`);
  const ids = new Set<string>();
  const byId = new Map<string, Phase12Node>();
  for (const node of nodes) {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(node.id) || ids.has(node.id)) throw new Phase12Error("invalid_plan", `DAG node ID "${node.id}" is invalid or duplicated.`);
    if (containsRecursiveInstruction(node.task)) throw new Phase12Error("recursive_instruction", `DAG node ${node.id} contains an unbounded or recursive instruction.`);
    if (!Number.isInteger(node.maxRetries) || node.maxRetries < 0 || node.maxRetries > PHASE12_MAX_RETRIES) throw new Phase12Error("resource_limit", `DAG node ${node.id} has an invalid retry bound.`);
    if (!Number.isFinite(node.timeoutMs) || node.timeoutMs < 1 || node.timeoutMs > PHASE12_MAX_TIMEOUT_MS) throw new Phase12Error("resource_limit", `DAG node ${node.id} has an invalid timeout.`);
    if (node.boundedIO.maxInputBytes < 1 || node.boundedIO.maxInputBytes > PHASE12_MAX_INPUT_BYTES || node.boundedIO.maxOutputBytes < 1 || node.boundedIO.maxOutputBytes > PHASE12_MAX_OUTPUT_BYTES) {
      throw new Phase12Error("resource_limit", `DAG node ${node.id} exceeds bounded I/O limits.`);
    }
    ids.add(node.id);
    byId.set(node.id, node);
  }
  for (const node of nodes) for (const dependency of node.dependencies) {
    if (dependency === node.id) throw new Phase12Error("cycle", `DAG node ${node.id} cannot depend on itself.`);
    if (!ids.has(dependency)) throw new Phase12Error("invalid_plan", `DAG node ${node.id} depends on missing node ${dependency}.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Phase12Error("cycle", `Phase 12 DAG contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

export async function runPhase12Dag(input: {
  sessionId: string;
  nodes: readonly Phase12Node[];
  operations: ReadonlyMap<string, RufloTaskOperation>;
  limits?: Partial<RufloSwarmLimits>;
  approved?: boolean;
  onNode?: (node: Phase12Node) => void;
  signal?: AbortSignal;
}): Promise<Phase12DagResult> {
  validatePhase12Dag(input.nodes);
  const nodes = input.nodes.map((node) => ({ ...node, dependencies: [...node.dependencies], toolDependencies: [...node.toolDependencies] }));
  const approvalNodes = nodes.filter((node) => node.approvalRequired);
  if (approvalNodes.length && input.approved !== true) {
    for (const node of approvalNodes) node.state = "WAITING_APPROVAL";
    return { status: "waiting_approval", nodes, outputs: {}, failures: [] };
  }
  if (input.signal?.aborted) {
    for (const node of nodes) node.state = "CANCELLED";
    return { status: "cancelled", nodes, outputs: {}, failures: [] };
  }
  const taskById = new Map<string, Phase12Node>();
  const tasks: RufloSwarmTask[] = nodes.map((node) => {
    taskById.set(node.id, node);
    return {
      taskId: node.id,
      sessionId: input.sessionId,
      role: phase12RoleToRufloRole(node.agent),
      description: node.task,
      dependencies: [...node.dependencies],
      priority: 0,
      status: "pending",
      attempts: node.retries,
      timeout: node.timeoutMs,
      permissions: node.approvalRequired ? ["proposal"] : ["read"],
      expectedFiles: [],
      readIntent: [],
      writeIntent: [],
      createdAt: new Date().toISOString(),
    };
  });
  const outputs: Record<string, unknown> = {};
  const operations = new Map<string, RufloTaskOperation>();
  for (const node of nodes) {
    const operation = input.operations.get(node.id);
    operations.set(node.id, async (task, context) => {
      node.state = "RUNNING";
      input.onNode?.({ ...node });
      if (!operation) throw new Phase12Error("invalid_plan", `No bounded operation was registered for node ${node.id}.`);
      const output = await operation(task, context);
      outputs[node.id] = boundJson(output, node.boundedIO.maxOutputBytes);
      return output;
    });
  }
  const scheduler = new RufloDynamicDagScheduler({
    sessionId: input.sessionId,
    tasks,
    operations,
    limits: input.limits,
    onTask: (task) => {
      const node = taskById.get(task.taskId);
      if (!node) return;
      const attempts = task.attempts;
      node.retries = attempts;
      node.state = task.status === "in_progress"
        ? "RUNNING"
        : task.status === "completed"
          ? "SUCCEEDED"
          : task.status === "failed"
            ? "FAILED"
            : task.status === "blocked"
              ? "BLOCKED"
              : task.status === "cancelled"
                ? "CANCELLED"
                : attempts > 0 ? "RETRYING" : node.dependencies.length ? "PENDING" : "READY";
      input.onNode?.({ ...node });
    },
  });
  if (input.signal) {
    if (input.signal.aborted) scheduler.cancel();
    else input.signal.addEventListener("abort", () => scheduler.cancel(), { once: true });
  }
  const result = await scheduler.run();
  const failures = result.tasks
    .filter((task) => task.status === "failed")
    .map((task) => diagnosePhase12Failure(new Error(task.error ?? "Phase 12 node failed"), { nodeId: task.taskId }));
  return {
    status: result.status,
    nodes,
    outputs,
    failures,
  };
}

export function classifyPhase12Failure(error: unknown): Phase12FailureCategory {
  const value = `${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`.toLowerCase();
  if (/schema|invalid|validation/.test(value)) return "VALIDATION";
  if (/unauthor|permission|forbidden|approval|owner/.test(value)) return "AUTHORIZATION";
  if (/capability|disabled|not allowed/.test(value)) return "CAPABILITY";
  if (/timeout|timed out|deadline/.test(value)) return "TIMEOUT";
  if (/resource|limit|too large|queue/.test(value)) return "RESOURCE";
  if (/network|fetch|dns|socket|ssrf/.test(value)) return "NETWORK";
  if (/provider|model|rate.?limit|context.?limit/.test(value)) return "PROVIDER";
  if (/depend|blocked/.test(value)) return "DEPENDENCY";
  if (/workspace|path|repository|symlink/.test(value)) return "WORKSPACE";
  if (/agent|lease|heartbeat/.test(value)) return "AGENT";
  if (/workflow|dag|task/.test(value)) return "WORKFLOW";
  if (/tool|adapter|executor/.test(value)) return "TOOL";
  return "UNKNOWN";
}

export function diagnosePhase12Failure(error: unknown, context: Omit<Phase12Diagnostic, "category" | "message" | "rootCause" | "retryable"> = {}): Phase12Diagnostic {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
  const stack = error instanceof Error ? error.stack?.slice(0, 6_000) : undefined;
  const location = stack?.match(/\(?([^()\s]+):(\d+):\d+\)?/);
  const category = classifyPhase12Failure(error);
  return {
    ...context,
    category,
    message,
    stack,
    file: context.file ?? location?.[1],
    line: context.line ?? (location?.[2] ? Number(location[2]) : undefined),
    rootCause: "ROOT CAUSE NOT CONFIRMED — insufficient evidence.",
    retryable: canRetryPhase12(category),
  };
}

export function canRetryPhase12(category: Phase12FailureCategory): boolean {
  if (NEVER_RETRY.has(category)) return false;
  return RETRYABLE_FAILURES.has(category);
}

export function createPhase12ProviderTraces(
  sessionId: string,
  decision: RufloRoutingDecision,
  attempts: readonly RufloProviderAttempt[] = [],
): Phase12ProviderTrace[] {
  return attempts.map((attempt) => ({
    sessionId,
    capability: attempt.capability,
    provider: attempt.provider,
    model: attempt.model,
    reason: decision.reason,
    fallbackUsed: attempt.fallbackUsed,
    classification: attempt.classification,
  }));
}

export function createPhase12MemoryScope(input: Phase12MemoryScope): Phase12MemoryScope {
  return {
    userId: input.userId.slice(0, 120),
    projectId: input.projectId.slice(0, 120),
    workspaceId: input.workspaceId.slice(0, 120),
    sessionId: input.sessionId.slice(0, 120),
  };
}

export function createPhase12Experience(input: {
  scope: Phase12MemoryScope;
  pattern: string;
  provenance: string;
  confidence: number;
  ttlMs?: number;
  now?: Date;
}): Phase12Experience {
  const scope = createPhase12MemoryScope(input.scope);
  return {
    id: randomUUID(),
    scope,
    pattern: input.pattern.trim().slice(0, 2_000),
    provenance: input.provenance.trim().slice(0, 500),
    confidence: Math.max(0, Math.min(1, input.confidence)),
    expiresAt: new Date((input.now ?? new Date()).getTime() + Math.max(60_000, Math.min(input.ttlMs ?? 30 * 24 * 60 * 60_000, 90 * 24 * 60 * 60_000))).toISOString(),
  };
}

export class Phase12Metrics {
  private readonly values: Phase12MetricsSnapshot = {
    sessions: 0, plans: 0, nodes: 0, succeeded: 0, failed: 0, cancelled: 0,
    retries: 0, approvals: 0, providerAttempts: 0, recoveryAttempts: 0,
  };

  record(event: keyof Phase12MetricsSnapshot, amount = 1): void {
    this.values[event] = Math.max(0, this.values[event] + Math.min(10_000, Math.floor(amount)));
  }

  snapshot(): Phase12MetricsSnapshot {
    return { ...this.values };
  }
}

export type Phase12Checkpoint = {
  id: string;
  ownerId: string;
  projectId: string;
  sessionId: string;
  nodeStates: Record<string, Phase12NodeState>;
  outputs: Record<string, unknown>;
  approvalVersion: string | null;
  createdAt: string;
};

export type Phase12CheckpointStore = {
  save: (checkpoint: Phase12Checkpoint) => Promise<Phase12Checkpoint>;
  get: (ownerId: string, sessionId: string, checkpointId: string) => Promise<Phase12Checkpoint | undefined>;
};

export class InMemoryPhase12CheckpointStore implements Phase12CheckpointStore {
  private readonly checkpoints = new Map<string, Phase12Checkpoint>();

  async save(checkpoint: Phase12Checkpoint): Promise<Phase12Checkpoint> {
    const encoded = JSON.stringify(checkpoint);
    if (Buffer.byteLength(encoded, "utf8") > PHASE12_MAX_CHECKPOINT_BYTES) throw new Phase12Error("resource_limit", "Phase 12 checkpoint exceeds its bounded size.");
    const copy = structuredClone(checkpoint);
    this.checkpoints.set(copy.id, copy);
    return structuredClone(copy);
  }

  async get(ownerId: string, sessionId: string, checkpointId: string): Promise<Phase12Checkpoint | undefined> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint || checkpoint.ownerId !== ownerId || checkpoint.sessionId !== sessionId) return undefined;
    return structuredClone(checkpoint);
  }
}

export function createPhase12ActivityCheckpointStore(store: RufloSessionStore): Phase12CheckpointStore {
  return {
    async save(checkpoint) {
      const encoded = JSON.stringify(checkpoint);
      if (Buffer.byteLength(encoded, "utf8") > PHASE12_MAX_CHECKPOINT_BYTES) throw new Phase12Error("resource_limit", "Phase 12 checkpoint exceeds its bounded size.");
      await store.createActivity(checkpoint.ownerId, {
        sessionId: checkpoint.sessionId,
        kind: "phase12_checkpoint",
        message: encoded,
      });
      return structuredClone(checkpoint);
    },
    async get(ownerId, sessionId, checkpointId) {
      const activities = await store.listActivities(ownerId, sessionId);
      for (const activity of [...activities].reverse()) {
        if (activity.kind !== "phase12_checkpoint") continue;
        try {
          const value = JSON.parse(activity.message) as Phase12Checkpoint;
          if (value.id === checkpointId && value.ownerId === ownerId && value.sessionId === sessionId) return value;
        } catch {
          continue;
        }
      }
      return undefined;
    },
  };
}

export function assertPhase12Resume(
  checkpoint: Phase12Checkpoint,
  input: { ownerId: string; projectId: string; sessionId: string; approvalVersion: string | null },
): void {
  if (checkpoint.ownerId !== input.ownerId || checkpoint.projectId !== input.projectId || checkpoint.sessionId !== input.sessionId) {
    throw new Phase12Error("ownership", "Phase 12 resume rejected because the checkpoint ownership or workspace binding changed.");
  }
  if (checkpoint.approvalVersion !== input.approvalVersion) {
    throw new Phase12Error("checkpoint_invalid", "Phase 12 resume rejected because the approval binding changed.");
  }
}

function phase12RoleToRufloRole(agentId: string): RufloAgentRole {
  const role = agentId.split(":").at(-1) ?? agentId;
  if (role === "researcher" || role === "tester" || role === "security" || role === "docs") return role === "researcher" ? "planner" : role === "tester" ? "test_generator" : role === "security" ? "reviewer" : "documentation";
  if (role === "planner" || role === "coder" || role === "reviewer") return role;
  return "planner";
}

function containsRecursiveInstruction(value: string): boolean {
  return /\b(recurs(?:e|ive|ion)|spawn\s+(?:an?|another|more)|infinite|indefinitely|unbounded|while\s+true|self[- ]?modify)\b/i.test(value);
}

function boundJson(value: unknown, maxBytes: number): unknown {
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Phase12Error("resource_limit", "Phase 12 node output exceeded its bounded resource limit.");
  return JSON.parse(encoded);
}