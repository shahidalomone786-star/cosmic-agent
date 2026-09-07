import { randomUUID } from "node:crypto";

export type RufloJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "dead_letter";

export type RufloJobRecord = {
  id: string;
  ownerId: string;
  sessionId: string;
  kind: string;
  status: RufloJobStatus;
  attempts: number;
  maxRetries: number;
  maxRuntimeMs: number;
  error?: string;
  resultSummary?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  idempotencyKey?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  deadLetteredAt?: string;
  nextAttemptAt?: string;
};

export type RufloJobContext = {
  signal: AbortSignal;
  job: RufloJobRecord;
};

export type RufloJobStore = {
  create: (job: RufloJobRecord) => Promise<void>;
  update: (job: RufloJobRecord) => Promise<void>;
  get: (ownerId: string, jobId: string) => Promise<RufloJobRecord | undefined>;
  list?: (ownerId: string, limit?: number) => Promise<RufloJobRecord[]>;
  findByIdempotency?: (ownerId: string, idempotencyKey: string) => Promise<RufloJobRecord | undefined>;
};

export type RufloJobManagerOptions = {
  store: RufloJobStore;
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
  defaultMaxRetries?: number;
  defaultMaxRuntimeMs?: number;
  onState?: (job: RufloJobRecord, event: "queued" | "started" | "completed" | "failed" | "cancelled" | "retrying") => void;
};

export class InMemoryRufloJobStore implements RufloJobStore {
  private readonly jobs = new Map<string, RufloJobRecord>();

  async create(job: RufloJobRecord): Promise<void> {
    this.jobs.set(job.id, cloneJob(job));
  }

  async update(job: RufloJobRecord): Promise<void> {
    this.jobs.set(job.id, cloneJob(job));
  }

  async get(ownerId: string, jobId: string): Promise<RufloJobRecord | undefined> {
    const job = this.jobs.get(jobId);
    return job && job.ownerId === ownerId ? cloneJob(job) : undefined;
  }

  async findByIdempotency(ownerId: string, idempotencyKey: string): Promise<RufloJobRecord | undefined> {
    const job = [...this.jobs.values()].find((candidate) => candidate.ownerId === ownerId && candidate.idempotencyKey === idempotencyKey);
    return job ? cloneJob(job) : undefined;
  }
}

export class RufloJobManager {
  private readonly queue: Array<{
    job: RufloJobRecord;
    execute: (context: RufloJobContext) => Promise<unknown>;
    controller: AbortController;
  }> = [];
  private readonly active = new Map<string, AbortController>();
  private readonly activeJobs = new Map<string, RufloJobRecord>();
  private pumping = false;
  private readonly maxConcurrentJobs: number;
  private readonly maxQueuedJobs: number;
  private readonly defaultMaxRetries: number;
  private readonly defaultMaxRuntimeMs: number;

  constructor(private readonly options: RufloJobManagerOptions) {
    this.maxConcurrentJobs = boundedInteger(options.maxConcurrentJobs, 1, 4, 2);
    this.maxQueuedJobs = boundedInteger(options.maxQueuedJobs, 1, 64, 16);
    this.defaultMaxRetries = boundedInteger(options.defaultMaxRetries, 0, 3, 1);
    this.defaultMaxRuntimeMs = boundedInteger(options.defaultMaxRuntimeMs, 1_000, 120_000, 45_000);
  }

  async enqueue(input: {
    ownerId: string;
    sessionId: string;
    kind: string;
    execute: (context: RufloJobContext) => Promise<unknown>;
    maxRetries?: number;
    maxRuntimeMs?: number;
    idempotencyKey?: string;
  }): Promise<RufloJobRecord> {
    if (this.queue.length >= this.maxQueuedJobs) throw new RufloJobError("queue_full", "Ruflo's bounded job queue is full.");
    if (input.idempotencyKey && this.options.store.findByIdempotency) {
      const existing = await this.options.store.findByIdempotency(input.ownerId, input.idempotencyKey);
      if (existing) return cloneJob(existing);
    }
    const now = new Date().toISOString();
    const job: RufloJobRecord = {
      id: randomUUID(),
      ownerId: input.ownerId.slice(0, 200),
      sessionId: input.sessionId.slice(0, 200),
      kind: input.kind.slice(0, 100),
      status: "queued",
      attempts: 0,
      maxRetries: boundedInteger(input.maxRetries, 0, 3, this.defaultMaxRetries),
      maxRuntimeMs: boundedInteger(input.maxRuntimeMs, 1_000, 120_000, this.defaultMaxRuntimeMs),
      createdAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey?.slice(0, 200),
    };
    await this.options.store.create(job);
    this.queue.push({ job, execute: input.execute, controller: new AbortController() });
    this.options.onState?.(cloneJob(job), "queued");
    void this.pump();
    return cloneJob(job);
  }

  async get(ownerId: string, jobId: string): Promise<RufloJobRecord | undefined> {
    return this.options.store.get(ownerId, jobId);
  }

  async cancel(ownerId: string, jobId: string): Promise<RufloJobRecord | undefined> {
    const queued = this.queue.find((item) => item.job.id === jobId && item.job.ownerId === ownerId);
    if (queued) {
      queued.controller.abort();
      queued.job.status = "cancelled";
      queued.job.updatedAt = new Date().toISOString();
      queued.job.completedAt = queued.job.updatedAt;
      await this.persist(queued.job);
      this.options.onState?.(cloneJob(queued.job), "cancelled");
      return cloneJob(queued.job);
    }
    const current = await this.options.store.get(ownerId, jobId);
    const controller = this.active.get(jobId);
    if (!current || !controller || current.status !== "running") return current;
    const activeJob = this.activeJobs.get(jobId);
    if (activeJob) activeJob.status = "cancelled";
    controller.abort();
    const cancelled = activeJob ?? current;
    cancelled.status = "cancelled";
    cancelled.updatedAt = new Date().toISOString();
    cancelled.completedAt = cancelled.updatedAt;
    await this.persist(cancelled);
    this.options.onState?.(cloneJob(cancelled), "cancelled");
    return cloneJob(cancelled);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.maxConcurrentJobs) {
        const item = this.queue.find((candidate) => candidate.job.status === "queued");
        if (!item) break;
        this.queue.splice(this.queue.indexOf(item), 1);
        void this.run(item);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(item: {
    job: RufloJobRecord;
    execute: (context: RufloJobContext) => Promise<unknown>;
    controller: AbortController;
  }): Promise<void> {
    const { job, controller } = item;
    this.active.set(job.id, controller);
    this.activeJobs.set(job.id, job);
    job.status = "running";
    job.attempts += 1;
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    await this.persist(job);
    this.options.onState?.(cloneJob(job), "started");

    try {
      const result = await withJobTimeout(item.execute({ signal: controller.signal, job: cloneJob(job) }), job.maxRuntimeMs, controller);
      if (controller.signal.aborted) {
        if ((job as RufloJobRecord).status === "cancelled") return;
        throw new Error("Ruflo job exceeded its runtime limit.");
      }
      job.status = "completed";
      job.durationMs = Date.now() - new Date(job.startedAt ?? job.updatedAt).getTime();
      job.resultSummary = summarizeResult(result);
      job.updatedAt = new Date().toISOString();
      job.completedAt = job.updatedAt;
      await this.persist(job);
      this.options.onState?.(cloneJob(job), "completed");
    } catch (error) {
      if (controller.signal.aborted && (job as RufloJobRecord).status === "cancelled") return;
      const message = error instanceof Error ? error.message : "Ruflo job failed.";
      if (job.attempts <= job.maxRetries) {
        job.status = "queued";
        job.error = sanitize(message);
        const backoffMs = Math.min(30_000, 250 * 2 ** Math.max(0, job.attempts - 1));
        job.nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
        job.updatedAt = new Date().toISOString();
        await this.persist(job);
        this.options.onState?.(cloneJob(job), "retrying");
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        this.queue.push({ ...item, controller: new AbortController() });
        void this.pump();
      } else {
        job.status = "failed";
        job.durationMs = Date.now() - new Date(job.startedAt ?? job.updatedAt).getTime();
        job.error = sanitize(message);
        job.updatedAt = new Date().toISOString();
        job.completedAt = job.updatedAt;
        await this.persist(job);
        this.options.onState?.(cloneJob(job), "failed");
      }
    } finally {
      this.active.delete(job.id);
      this.activeJobs.delete(job.id);
      void this.pump();
    }
  }

  private async persist(job: RufloJobRecord): Promise<void> {
    await this.options.store.update(cloneJob(job));
  }
}

export class RufloJobError extends Error {
  constructor(readonly code: "queue_full" | "not_found", message: string) {
    super(message);
    this.name = "RufloJobError";
  }
}

async function withJobTimeout<T>(operation: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Ruflo job exceeded its runtime limit."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value as number))) : fallback;
}

function summarizeResult(value: unknown): string {
  if (typeof value === "string") return sanitize(value).slice(0, 1_000);
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return sanitize(value.message).slice(0, 1_000);
  return "Ruflo job completed.";
}

function sanitize(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 1_000);
}

function cloneJob(job: RufloJobRecord): RufloJobRecord {
  return { ...job };
}