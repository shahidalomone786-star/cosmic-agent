import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, or } from "drizzle-orm";
import {
  db,
  rufloGovernanceAuditTable,
  rufloJobsTable,
  workspaceMembersTable,
  workspaceProjectsTable,
  usersTable,
} from "@workspace/db";
import type { RufloJobRecord, RufloJobStore } from "./ruflo-jobs";

export type WorkspaceRole = "owner" | "collaborator" | "viewer";
export type WorkspaceAccess = { workspaceId: string; ownerId: string; projectId: string; role: WorkspaceRole };

export async function ensureWorkspaceProject(ownerId: string, projectId: string, name = projectId): Promise<WorkspaceAccess> {
  const cleanProject = projectId.trim().slice(0, 120) || "default";
  const existing = await db
    .select({ workspaceId: workspaceProjectsTable.id, ownerId: workspaceProjectsTable.ownerId, projectId: workspaceProjectsTable.projectId })
    .from(workspaceProjectsTable)
    .where(and(eq(workspaceProjectsTable.ownerId, ownerId), eq(workspaceProjectsTable.projectId, cleanProject)))
    .limit(1);
  const project = existing[0] ?? (await db.insert(workspaceProjectsTable).values({
    id: randomUUID(),
    ownerId,
    projectId: cleanProject,
    name: name.trim().slice(0, 160) || cleanProject,
  }).returning({ workspaceId: workspaceProjectsTable.id, ownerId: workspaceProjectsTable.ownerId, projectId: workspaceProjectsTable.projectId }))[0];
  if (!project) throw new Error("Workspace project could not be registered.");
  await db.insert(workspaceMembersTable).values({
    id: randomUUID(),
    workspaceId: project.workspaceId,
    userId: ownerId,
    role: "owner",
  }).onConflictDoNothing();
  return { ...project, role: "owner" };
}

export async function getWorkspaceAccess(userId: string, projectId: string): Promise<WorkspaceAccess | undefined> {
  const [row] = await db
    .select({
      workspaceId: workspaceProjectsTable.id,
      ownerId: workspaceProjectsTable.ownerId,
      projectId: workspaceProjectsTable.projectId,
      role: workspaceMembersTable.role,
    })
    .from(workspaceMembersTable)
    .innerJoin(workspaceProjectsTable, eq(workspaceProjectsTable.id, workspaceMembersTable.workspaceId))
    .where(and(eq(workspaceMembersTable.userId, userId), eq(workspaceProjectsTable.projectId, projectId.trim().slice(0, 120))))
    .limit(1);
  return row ? { ...row, role: row.role as WorkspaceRole } : undefined;
}

export async function resolveWorkspaceAccess(userId: string, projectId: string): Promise<WorkspaceAccess | undefined> {
  const existing = await getWorkspaceAccess(userId, projectId);
  if (existing) return existing;
  const [project] = await db.select({ id: workspaceProjectsTable.id })
    .from(workspaceProjectsTable)
    .where(eq(workspaceProjectsTable.projectId, projectId.trim().slice(0, 120)))
    .limit(1);
  return project ? undefined : ensureWorkspaceProject(userId, projectId);
}

export function canReadWorkspace(role: WorkspaceRole): boolean {
  return role === "owner" || role === "collaborator" || role === "viewer";
}

export function canWriteWorkspace(role: WorkspaceRole): boolean {
  return role === "owner" || role === "collaborator";
}

export function canManageWorkspace(role: WorkspaceRole): boolean {
  return role === "owner";
}

export async function grantWorkspaceMember(ownerId: string, projectId: string, email: string, role: Exclude<WorkspaceRole, "owner">): Promise<WorkspaceAccess> {
  const workspace = await ensureWorkspaceProject(ownerId, projectId);
  const [target] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email.trim().toLowerCase())).limit(1);
  if (!target) throw new Error("The invited account does not exist.");
  const [member] = await db.insert(workspaceMembersTable).values({
    id: randomUUID(),
    workspaceId: workspace.workspaceId,
    userId: target.id,
    role,
  }).onConflictDoUpdate({
    target: [workspaceMembersTable.workspaceId, workspaceMembersTable.userId],
    set: { role, updatedAt: new Date() },
  }).returning();
  if (!member) throw new Error("Workspace membership could not be saved.");
  return { ...workspace, role };
}

export async function listWorkspaceMembers(ownerId: string, projectId: string) {
  const workspace = await ensureWorkspaceProject(ownerId, projectId);
  return db.select({
    userId: workspaceMembersTable.userId,
    email: usersTable.email,
    role: workspaceMembersTable.role,
    createdAt: workspaceMembersTable.createdAt,
  }).from(workspaceMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, workspaceMembersTable.userId))
    .where(eq(workspaceMembersTable.workspaceId, workspace.workspaceId))
    .orderBy(asc(usersTable.email));
}

export async function removeWorkspaceMember(ownerId: string, projectId: string, memberId: string): Promise<boolean> {
  const workspace = await ensureWorkspaceProject(ownerId, projectId);
  const removed = await db.delete(workspaceMembersTable).where(and(
    eq(workspaceMembersTable.workspaceId, workspace.workspaceId),
    eq(workspaceMembersTable.userId, memberId),
  )).returning({ id: workspaceMembersTable.id });
  return removed.length > 0;
}

export async function recordGovernanceAudit(input: {
  userId: string;
  workspaceId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  status?: "allowed" | "denied" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(rufloGovernanceAuditTable).values({
    id: randomUUID(),
    userId: input.userId,
    workspaceId: input.workspaceId,
    action: input.action.slice(0, 120),
    resourceType: input.resourceType.slice(0, 80),
    resourceId: input.resourceId?.slice(0, 160),
    status: input.status ?? "completed",
    metadata: sanitizeMetadata(input.metadata ?? {}),
  });
}

export async function listGovernanceAudit(userId: string, limit = 100) {
  return db.select().from(rufloGovernanceAuditTable)
    .where(eq(rufloGovernanceAuditTable.userId, userId))
    .orderBy(desc(rufloGovernanceAuditTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export class UserRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number, readonly action: string) {
    super(`Rate limit exceeded for ${action}.`);
    this.name = "UserRateLimitError";
  }
}

type Bucket = { startedAt: number; count: number };
const rateBuckets = new Map<string, Bucket>();
const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  job_create: { max: 8, windowMs: 60_000 },
  file_read: { max: 240, windowMs: 60_000 },
  file_write: { max: 60, windowMs: 60_000 },
  secret: { max: 20, windowMs: 60_000 },
  api: { max: 600, windowMs: 60_000 },
};

export function enforceUserRateLimit(userId: string, action: keyof typeof RATE_LIMITS): void {
  const now = Date.now();
  const policy = RATE_LIMITS[action];
  const key = `${userId}:${action}`;
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= policy.windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= policy.max) {
    throw new UserRateLimitError(Math.ceil((policy.windowMs - (now - current.startedAt)) / 1000), action);
  }
  current.count += 1;
}

export function rateLimitPolicy() {
  return Object.fromEntries(Object.entries(RATE_LIMITS).map(([action, value]) => [action, { ...value }]));
}

export class DurableRufloJobStore implements RufloJobStore {
  async create(job: RufloJobRecord): Promise<void> {
    await db.insert(rufloJobsTable).values(toJobRow(job));
  }
  async update(job: RufloJobRecord): Promise<void> {
    await db.update(rufloJobsTable).set(toJobRow(job)).where(eq(rufloJobsTable.id, job.id));
  }
  async get(ownerId: string, jobId: string): Promise<RufloJobRecord | undefined> {
    const [row] = await db.select().from(rufloJobsTable).where(and(eq(rufloJobsTable.ownerId, ownerId), eq(rufloJobsTable.id, jobId))).limit(1);
    return row ? fromJobRow(row) : undefined;
  }
  async findByIdempotency(ownerId: string, idempotencyKey: string): Promise<RufloJobRecord | undefined> {
    const [row] = await db.select().from(rufloJobsTable).where(and(
      eq(rufloJobsTable.ownerId, ownerId),
      eq(rufloJobsTable.idempotencyKey, idempotencyKey),
    )).limit(1);
    return row ? fromJobRow(row) : undefined;
  }
  async list(ownerId: string, limit = 100): Promise<RufloJobRecord[]> {
    const rows = await db.select().from(rufloJobsTable).where(eq(rufloJobsTable.ownerId, ownerId)).orderBy(desc(rufloJobsTable.createdAt)).limit(Math.min(Math.max(limit, 1), 200));
    return rows.map(fromJobRow);
  }
  async recoverInterrupted(): Promise<number> {
    const interrupted = await db.update(rufloJobsTable).set({
      status: "dead_letter",
      error: "The single runtime restarted before this job completed; it was not replayed to prevent duplicate side effects.",
      deadLetteredAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    }).where(or(eq(rufloJobsTable.status, "running"), eq(rufloJobsTable.status, "queued"))).returning({ id: rufloJobsTable.id });
    return interrupted.length;
  }
}

function toJobRow(job: RufloJobRecord) {
  return {
    id: job.id,
    ownerId: job.ownerId,
    sessionId: job.sessionId,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    maxRetries: job.maxRetries,
    maxRuntimeMs: job.maxRuntimeMs,
    idempotencyKey: job.idempotencyKey,
    error: job.error,
    resultSummary: job.resultSummary,
    durationMs: job.durationMs,
    inputTokens: job.inputTokens,
    outputTokens: job.outputTokens,
    estimatedCostUsd: job.estimatedCostUsd,
    deadLetteredAt: job.deadLetteredAt ? new Date(job.deadLetteredAt) : undefined,
    nextAttemptAt: job.nextAttemptAt ? new Date(job.nextAttemptAt) : undefined,
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt),
    startedAt: job.startedAt ? new Date(job.startedAt) : undefined,
    completedAt: job.completedAt ? new Date(job.completedAt) : undefined,
  };
}

function fromJobRow(row: typeof rufloJobsTable.$inferSelect): RufloJobRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    sessionId: row.sessionId,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    maxRetries: row.maxRetries,
    maxRuntimeMs: row.maxRuntimeMs,
    idempotencyKey: row.idempotencyKey ?? undefined,
    error: row.error ?? undefined,
    resultSummary: row.resultSummary ?? undefined,
    durationMs: row.durationMs ?? undefined,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    estimatedCostUsd: row.estimatedCostUsd ?? undefined,
    deadLetteredAt: row.deadLetteredAt?.toISOString(),
    nextAttemptAt: row.nextAttemptAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).slice(0, 24).map(([key, value]) => [
    key,
    /(secret|token|password|credential|authorization|cookie|private)/i.test(key) ? "[redacted]" : typeof value === "string" ? value.slice(0, 500) : value,
  ]));
}