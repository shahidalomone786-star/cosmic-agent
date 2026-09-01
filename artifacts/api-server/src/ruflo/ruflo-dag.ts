import type { RufloAgentRole } from "./ruflo-agents";
import type { RufloLimits } from "./ruflo-runtime";

export type RufloTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type RufloTaskIntent = "read" | "write";
export type RufloTaskPermission = "read" | "write" | "review" | "validate" | "proposal";

export type RufloSwarmTask<T = unknown> = {
  taskId: string;
  sessionId: string;
  role: RufloAgentRole;
  description: string;
  dependencies: string[];
  priority: number;
  status: RufloTaskStatus;
  attempts: number;
  timeout: number;
  permissions: RufloTaskPermission[];
  expectedFiles: string[];
  readIntent: string[];
  writeIntent: string[];
  result?: T;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type RufloTaskOperation<T = unknown> = (
  task: RufloSwarmTask<T>,
  context: RufloTaskExecutionContext,
) => Promise<T>;

export type RufloTaskExecutionContext = {
  signal: AbortSignal;
  consumeToolCall: () => void;
  workspaceRevision?: string;
  addTask: <T>(task: RufloSwarmTask<T>, operation: RufloTaskOperation<T>) => void;
};

export type RufloTaskResultEvidence = {
  readFiles?: string[];
  changedFiles?: string[];
  workspaceRevision?: string;
};

export type RufloSwarmLimits = {
  maxConcurrentAgents: number;
  maxTasks: number;
  maxTaskRuntimeMs: number;
  maxSessionRuntimeMs: number;
  maxToolCalls: number;
  maxRetries: number;
};

export const DEFAULT_RUFLO_SWARM_LIMITS: RufloSwarmLimits = {
  maxConcurrentAgents: 3,
  maxTasks: 16,
  maxTaskRuntimeMs: 45_000,
  maxSessionRuntimeMs: 120_000,
  maxToolCalls: 12,
  maxRetries: 1,
};

export type RufloSwarmResult = {
  status: "completed" | "failed" | "cancelled";
  tasks: RufloSwarmTask[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  blockedTaskIds: string[];
  cancelledTaskIds: string[];
  conflicts: RufloTaskConflict[];
  toolCalls: number;
  message: string;
};

export type RufloTaskConflict = {
  taskId: string;
  conflictingTaskId: string;
  files: string[];
  kind: "write_write" | "read_write" | "stale_workspace";
  message: string;
};

export class RufloDagError extends Error {
  constructor(
    readonly code:
      | "duplicate_task"
      | "missing_dependency"
      | "invalid_dependency"
      | "cycle"
      | "too_many_tasks"
      | "invalid_role"
      | "invalid_task"
      | "conflict"
      | "limit",
    message: string,
  ) {
    super(message);
    this.name = "RufloDagError";
  }
}

const VALID_ROLES = new Set<RufloAgentRole>(["planner", "coder", "reviewer", "validator", "fixer"]);
const VALID_PERMISSIONS = new Set<RufloTaskPermission>(["read", "write", "review", "validate", "proposal"]);
const MAX_CONCURRENT_AGENTS = 5;
const MAX_TASKS = 32;
const MAX_TASK_TIMEOUT_MS = 300_000;
const MAX_SESSION_RUNTIME_MS = 300_000;
const MAX_RETRIES = 5;

export class RufloTaskGraph {
  private readonly tasks = new Map<string, RufloSwarmTask>();

  constructor(tasks: readonly RufloSwarmTask[] = []) {
    for (const task of tasks) this.addTask(task);
  }

  addTask<T>(task: RufloSwarmTask<T>): void {
    validateTaskShape(task);
    if (this.tasks.has(task.taskId)) throw new RufloDagError("duplicate_task", `Task ${task.taskId} already exists.`);
    if (this.tasks.size >= MAX_TASKS) throw new RufloDagError("too_many_tasks", `Ruflo allows at most ${MAX_TASKS} tasks in one graph.`);
    this.tasks.set(task.taskId, cloneTask(task));
    try {
      validateTaskGraph([...this.tasks.values()]);
    } catch (error) {
      this.tasks.delete(task.taskId);
      throw error;
    }
  }

  get(taskId: string): RufloSwarmTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  snapshot(): RufloSwarmTask[] {
    return [...this.tasks.values()].map(cloneTask);
  }

  validate(): void {
    validateTaskGraph([...this.tasks.values()]);
  }

  ready(): RufloSwarmTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.status === "pending" && task.dependencies.every((id) => this.tasks.get(id)?.status === "completed"))
      .sort(compareTasks)
      .map(cloneTask);
  }
}

type SchedulerInput = {
  sessionId: string;
  tasks?: readonly RufloSwarmTask[];
  operations?: ReadonlyMap<string, RufloTaskOperation>;
  limits?: Partial<RufloSwarmLimits> & Partial<RufloLimits>;
  getWorkspaceRevision?: () => Promise<string>;
  onTask?: (task: RufloSwarmTask) => void;
};

type ActiveTask = {
  taskId: string;
  controller: AbortController;
  promise: Promise<void>;
};

export class RufloDynamicDagScheduler {
  private readonly sessionId: string;
  private readonly graph: RufloTaskGraph;
  private readonly operations = new Map<string, RufloTaskOperation>();
  private readonly limits: RufloSwarmLimits;
  private readonly locks = new RufloResourceLockManager();
  private readonly onTask?: (task: RufloSwarmTask) => void;
  private readonly getWorkspaceRevision?: () => Promise<string>;
  private readonly conflicts: RufloTaskConflict[] = [];
  private readonly committedWrites = new Map<string, string>();
  private readonly active = new Map<string, ActiveTask>();
  private toolCalls = 0;
  private startedAt = 0;
  private cancelled = false;

  constructor(input: SchedulerInput) {
    if (!input.sessionId.trim()) throw new RufloDagError("invalid_task", "A session ID is required for DAG scheduling.");
    this.sessionId = input.sessionId;
    this.graph = new RufloTaskGraph(input.tasks ?? []);
    this.limits = normalizeLimits(input.limits);
    if (this.graph.snapshot().length > this.limits.maxTasks) {
      throw new RufloDagError("too_many_tasks", `Ruflo allows at most ${this.limits.maxTasks} tasks in one graph.`);
    }
    if (this.graph.snapshot().some((task) => task.sessionId !== this.sessionId)) {
      throw new RufloDagError("invalid_task", "Every task must belong to the scheduled Ruflo session.");
    }
    this.getWorkspaceRevision = input.getWorkspaceRevision;
    this.onTask = input.onTask;
    for (const [taskId, operation] of input.operations ?? []) this.operations.set(taskId, operation);
    for (const task of this.graph.snapshot()) {
      if (!this.operations.has(task.taskId)) throw new RufloDagError("invalid_task", `No operation was provided for task ${task.taskId}.`);
    }
  }

  addTask<T>(task: RufloSwarmTask<T>, operation: RufloTaskOperation<T>): void {
    if (this.cancelled) throw new RufloDagError("invalid_task", "Cancelled schedulers cannot accept new tasks.");
    if (task.sessionId !== this.sessionId) throw new RufloDagError("invalid_task", "A task belongs to a different Ruflo session.");
    if (this.graph.snapshot().length >= this.limits.maxTasks) throw new RufloDagError("too_many_tasks", `Ruflo allows at most ${this.limits.maxTasks} tasks in one graph.`);
    this.graph.addTask(task);
    this.operations.set(task.taskId, operation as RufloTaskOperation);
  }

  cancel(): void {
    this.cancelled = true;
    for (const active of this.active.values()) active.controller.abort();
  }

  snapshot(): RufloSwarmTask[] {
    return this.graph.snapshot();
  }

  async run(): Promise<RufloSwarmResult> {
    this.graph.validate();
    this.startedAt = Date.now();
    while (true) {
      if (Date.now() - this.startedAt >= this.limits.maxSessionRuntimeMs) {
        this.cancelled = true;
        for (const active of this.active.values()) active.controller.abort();
      }
      if (this.cancelled) this.cancelPendingTasks("The Ruflo swarm was cancelled.");
      this.blockTasksWithFailedDependencies();
      this.startReadyTasks();
      if (!this.active.size) {
        const pending = this.graph.snapshot().filter((task) => task.status === "pending");
        if (pending.length) {
          if (Date.now() - this.startedAt >= this.limits.maxSessionRuntimeMs) {
            for (const task of pending) this.setStatus(task.taskId, "cancelled", "The Ruflo session runtime limit was reached.");
          } else {
            throw new RufloDagError("invalid_task", "The DAG has pending tasks that cannot become ready.");
          }
        }
        break;
      }
      await Promise.race([...this.active.values()].map((active) => active.promise));
    }

    const tasks = this.graph.snapshot();
    const completedTaskIds = tasks.filter((task) => task.status === "completed").map((task) => task.taskId);
    const failedTaskIds = tasks.filter((task) => task.status === "failed").map((task) => task.taskId);
    const blockedTaskIds = tasks.filter((task) => task.status === "blocked").map((task) => task.taskId);
    const cancelledTaskIds = tasks.filter((task) => task.status === "cancelled").map((task) => task.taskId);
    const status = cancelledTaskIds.length || this.cancelled ? "cancelled" : failedTaskIds.length || blockedTaskIds.length ? "failed" : "completed";
    return {
      status,
      tasks,
      completedTaskIds,
      failedTaskIds,
      blockedTaskIds,
      cancelledTaskIds,
      conflicts: [...this.conflicts],
      toolCalls: this.toolCalls,
      message: status === "completed" ? "All Ruflo DAG tasks completed." : "Ruflo stopped with isolated task failures or blocked dependents.",
    };
  }

  private startReadyTasks(): void {
    const available = Math.max(0, this.limits.maxConcurrentAgents - this.active.size);
    for (const task of this.graph.ready().slice(0, available)) {
      if (Date.now() - this.startedAt >= this.limits.maxSessionRuntimeMs) {
        this.setStatus(task.taskId, "cancelled", "The Ruflo session runtime limit was reached.");
        continue;
      }
      const operation = this.operations.get(task.taskId);
      if (!operation) {
        this.setStatus(task.taskId, "failed", "No operation was registered for the task.");
        continue;
      }
      const controller = new AbortController();
      this.setStatus(task.taskId, "in_progress");
      const promise = this.runTask(task.taskId, operation, controller).finally(() => this.active.delete(task.taskId));
      this.active.set(task.taskId, { taskId: task.taskId, controller, promise });
    }
  }

  private async runTask(taskId: string, operation: RufloTaskOperation, controller: AbortController): Promise<void> {
    const task = this.graph.get(taskId);
    if (!task) return;
    const release = this.locks.tryAcquire(this.sessionId, task.taskId, task.readIntent, task.writeIntent);
    if (!release) {
      this.setStatus(taskId, "pending");
      return;
    }
    const started = Date.now();
    const workspaceRevision = this.getWorkspaceRevision ? await this.getWorkspaceRevision() : undefined;
    const timeout = Math.min(task.timeout || this.limits.maxTaskRuntimeMs, this.limits.maxTaskRuntimeMs);
    try {
      const result = await withTimeout(
        operation(task, {
          signal: controller.signal,
          workspaceRevision,
          consumeToolCall: () => {
            if (this.toolCalls >= this.limits.maxToolCalls) throw new RufloDagError("limit", "Ruflo tool-call limit reached.");
            this.toolCalls += 1;
          },
          addTask: (newTask, newOperation) => this.addTask(newTask, newOperation),
        }),
        timeout,
        controller,
      );
      const evidence = taskEvidence(result);
      this.assertResultSafe(task, evidence, workspaceRevision);
      task.result = result;
      task.attempts += 1;
      task.status = "completed";
      task.completedAt = new Date().toISOString();
      if (evidence.changedFiles?.length) {
        for (const file of evidence.changedFiles) this.committedWrites.set(file, task.taskId);
      }
      this.replaceTask(task);
      this.onTask?.(cloneTask(task));
    } catch (error) {
      task.attempts += 1;
      if (task.attempts <= this.limits.maxRetries && !this.cancelled && !(error instanceof RufloDagError && error.code === "conflict")) {
        task.status = "pending";
        task.error = errorMessage(error);
        this.replaceTask(task);
        this.onTask?.(cloneTask(task));
        return;
      }
      task.status = this.cancelled ? "cancelled" : "failed";
      task.error = errorMessage(error);
      task.completedAt = new Date().toISOString();
      this.replaceTask(task);
      this.onTask?.(cloneTask(task));
    } finally {
      release();
      if (Date.now() - this.startedAt > this.limits.maxSessionRuntimeMs && task.status === "in_progress") {
        task.status = "failed";
        task.error = "The Ruflo session runtime limit was reached.";
      }
      void started;
    }
  }

  private assertResultSafe(task: RufloSwarmTask, evidence: RufloTaskResultEvidence, workspaceRevision?: string): void {
    const changedFiles = unique(evidence.changedFiles ?? task.writeIntent);
    const readFiles = unique(evidence.readFiles ?? task.readIntent);
    const expected = new Set(task.expectedFiles);
    if (expected.size && changedFiles.some((file) => !expected.has(file))) {
      throw new RufloDagError("conflict", `Task ${task.taskId} changed a file outside its expected file set.`);
    }
    for (const file of changedFiles) {
      const conflictingTaskId = this.committedWrites.get(file);
      if (conflictingTaskId && conflictingTaskId !== task.taskId) {
        this.recordConflict({
          taskId: task.taskId,
          conflictingTaskId,
          files: [file],
          kind: "write_write",
          message: `Task ${task.taskId} overlaps a completed write from ${conflictingTaskId}.`,
        });
      }
    }
    if (evidence.workspaceRevision && workspaceRevision && evidence.workspaceRevision !== workspaceRevision) {
      this.recordConflict({
        taskId: task.taskId,
        conflictingTaskId: "",
        files: changedFiles,
        kind: "stale_workspace",
        message: `Task ${task.taskId} produced a result against a stale workspace revision.`,
      });
    }
    for (const previous of this.graph.snapshot().filter((candidate) => candidate.status === "completed" && candidate.taskId !== task.taskId)) {
      const previousReads = taskEvidence(previous.result).readFiles ?? previous.readIntent;
      const overlap = intersect(changedFiles, previousReads);
      if (overlap.length && previous.startedAt && task.startedAt && previous.startedAt > task.startedAt) {
        this.recordConflict({
          taskId: task.taskId,
          conflictingTaskId: previous.taskId,
          files: overlap,
          kind: "read_write",
          message: `Task ${task.taskId} read files changed by ${previous.taskId}.`,
        });
      }
    }
  }

  private recordConflict(conflict: RufloTaskConflict): never {
    this.conflicts.push(conflict);
    throw new RufloDagError("conflict", conflict.message);
  }

  private blockTasksWithFailedDependencies(): void {
    for (const task of this.graph.snapshot()) {
      if (task.status !== "pending") continue;
      const failedDependency = task.dependencies.find((id) => {
        const dependency = this.graph.get(id);
        return dependency?.status === "failed" || dependency?.status === "blocked" || dependency?.status === "cancelled";
      });
      if (failedDependency) this.setStatus(task.taskId, "blocked", `Dependency ${failedDependency} did not complete.`);
    }
  }

  private cancelPendingTasks(message: string): void {
    for (const task of this.graph.snapshot()) {
      if (task.status === "pending") this.setStatus(task.taskId, "cancelled", message);
    }
  }

  private setStatus(taskId: string, status: RufloTaskStatus, error?: string): void {
    const task = this.graph.get(taskId);
    if (!task) return;
    task.status = status;
    if (error) task.error = error;
    if (status === "in_progress") task.startedAt = new Date().toISOString();
    if (status === "failed" || status === "blocked" || status === "cancelled") task.completedAt = new Date().toISOString();
    this.replaceTask(task);
    this.onTask?.(cloneTask(task));
  }

  private replaceTask(task: RufloSwarmTask): void {
    const graphTasks = this.graph as unknown as { tasks: Map<string, RufloSwarmTask> };
    graphTasks.tasks.set(task.taskId, task);
  }
}

export class RufloResourceLockManager {
  private readonly locks = new Map<string, { sessionId: string; taskId: string; intent: RufloTaskIntent }[]>();

  tryAcquire(sessionId: string, taskId: string, readFiles: readonly string[], writeFiles: readonly string[]): () => void {
    const intents = new Map<string, RufloTaskIntent>();
    for (const file of readFiles) intents.set(normalizeResource(file), "read");
    for (const file of writeFiles) intents.set(normalizeResource(file), "write");
    const resources = [...intents.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (resources.some(([resource, intent]) => {
      return (this.locks.get(resource) ?? []).some((lock) => lock.sessionId !== sessionId || lock.taskId !== taskId) &&
        (intent === "write" || (this.locks.get(resource) ?? []).some((lock) => lock.intent === "write"));
    })) return () => undefined;
    for (const [resource, intent] of resources) {
      const entries = this.locks.get(resource) ?? [];
      entries.push({ sessionId, taskId, intent });
      this.locks.set(resource, entries);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const [resource] of resources) {
        const remaining = (this.locks.get(resource) ?? []).filter((lock) => lock.sessionId !== sessionId || lock.taskId !== taskId);
        if (remaining.length) this.locks.set(resource, remaining);
        else this.locks.delete(resource);
      }
    };
  }

  snapshot(): Array<{ resource: string; sessionId: string; taskId: string; intent: RufloTaskIntent }> {
    return [...this.locks.entries()].flatMap(([resource, locks]) => locks.map((lock) => ({ resource, ...lock })));
  }
}

export function validateTaskGraph(tasks: readonly RufloSwarmTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    validateTaskShape(task);
    if (ids.has(task.taskId)) throw new RufloDagError("duplicate_task", `Task ${task.taskId} is duplicated.`);
    ids.add(task.taskId);
  }
  if (tasks.length > MAX_TASKS) throw new RufloDagError("too_many_tasks", `Ruflo allows at most ${MAX_TASKS} tasks in one graph.`);
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.taskId) throw new RufloDagError("invalid_dependency", `Task ${task.taskId} cannot depend on itself.`);
      if (!ids.has(dependency)) throw new RufloDagError("missing_dependency", `Task ${task.taskId} depends on missing task ${dependency}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new RufloDagError("cycle", `The Ruflo task graph contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.taskId);
}

export function normalizeRufloSwarmLimits(input: Partial<RufloSwarmLimits> & Partial<RufloLimits> = {}): RufloSwarmLimits {
  const maxAgents = clamp(input.maxAgentsPerSession ?? input.maxConcurrentAgents, DEFAULT_RUFLO_SWARM_LIMITS.maxConcurrentAgents, 1, MAX_CONCURRENT_AGENTS);
  return {
    maxConcurrentAgents: clamp(input.maxConcurrentAgents, maxAgents, 1, maxAgents),
    maxTasks: clamp(input.maxTasks, DEFAULT_RUFLO_SWARM_LIMITS.maxTasks, 1, MAX_TASKS),
    maxTaskRuntimeMs: clamp(input.maxTaskRuntimeMs, input.maxRuntimeMs ?? DEFAULT_RUFLO_SWARM_LIMITS.maxTaskRuntimeMs, 1, MAX_TASK_TIMEOUT_MS),
    maxSessionRuntimeMs: clamp(input.maxSessionRuntimeMs, DEFAULT_RUFLO_SWARM_LIMITS.maxSessionRuntimeMs, 1, MAX_SESSION_RUNTIME_MS),
    maxToolCalls: clamp(input.maxToolCalls, DEFAULT_RUFLO_SWARM_LIMITS.maxToolCalls, 1, 64),
    maxRetries: clamp(input.maxRetries, DEFAULT_RUFLO_SWARM_LIMITS.maxRetries, 0, MAX_RETRIES),
  };
}

function normalizeLimits(input: Partial<RufloSwarmLimits> & Partial<RufloLimits> | undefined): RufloSwarmLimits {
  return normalizeRufloSwarmLimits(input ?? {});
}

function validateTaskShape(task: RufloSwarmTask): void {
  if (!task || typeof task.taskId !== "string" || !task.taskId.trim()) throw new RufloDagError("invalid_task", "Every Ruflo task needs a task ID.");
  if (typeof task.sessionId !== "string" || !task.sessionId.trim()) throw new RufloDagError("invalid_task", `Task ${task.taskId} has no session ID.`);
  if (!VALID_ROLES.has(task.role)) throw new RufloDagError("invalid_role", `Task ${task.taskId} uses unsupported role ${String(task.role)}.`);
  if (!Array.isArray(task.dependencies) || new Set(task.dependencies).size !== task.dependencies.length) throw new RufloDagError("invalid_dependency", `Task ${task.taskId} has invalid dependencies.`);
  if (!Array.isArray(task.permissions) || task.permissions.some((permission) => !VALID_PERMISSIONS.has(permission))) {
    throw new RufloDagError("invalid_task", `Task ${task.taskId} has unsupported permissions.`);
  }
  if (task.writeIntent.length > 0 && !task.permissions.includes("write")) {
    throw new RufloDagError("invalid_task", `Task ${task.taskId} needs write permission for its write intent.`);
  }
  if (task.role === "reviewer" && !task.permissions.includes("review")) {
    throw new RufloDagError("invalid_task", `Reviewer task ${task.taskId} needs review permission.`);
  }
  if (task.role === "validator" && !task.permissions.includes("validate")) {
    throw new RufloDagError("invalid_task", `Validator task ${task.taskId} needs validate permission.`);
  }
  if (!Number.isFinite(task.priority) || !Number.isFinite(task.timeout) || task.timeout <= 0) throw new RufloDagError("invalid_task", `Task ${task.taskId} has invalid priority or timeout.`);
}

function cloneTask<T>(task: RufloSwarmTask<T>): RufloSwarmTask<T> {
  return { ...task, dependencies: [...task.dependencies], permissions: [...task.permissions], expectedFiles: [...task.expectedFiles], readIntent: [...task.readIntent], writeIntent: [...task.writeIntent] };
}

function compareTasks(a: RufloSwarmTask, b: RufloSwarmTask): number {
  return b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId);
}

function taskEvidence(result: unknown): RufloTaskResultEvidence {
  if (!result || typeof result !== "object") return {};
  const value = result as Record<string, unknown>;
  return {
    readFiles: Array.isArray(value.readFiles) ? value.readFiles.filter((file): file is string => typeof file === "string") : undefined,
    changedFiles: Array.isArray(value.changedFiles) ? value.changedFiles.filter((file): file is string => typeof file === "string") : undefined,
    workspaceRevision: typeof value.workspaceRevision === "string" ? value.workspaceRevision : undefined,
  };
}

function normalizeResource(resource: string): string {
  return resource.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeResource).filter(Boolean))];
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return left.filter((value) => other.has(value));
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value as number))) : fallback;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new RufloDagError("limit", `Task exceeded its ${timeoutMs}ms runtime limit.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Ruflo task failed.";
}