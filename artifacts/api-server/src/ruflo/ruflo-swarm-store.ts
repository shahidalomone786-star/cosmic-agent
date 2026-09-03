import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  db,
  rufloAgentsTable,
  rufloBlackboardTable,
  rufloConsensusTable,
  rufloSwarmEventsTable,
  rufloSwarmMessagesTable,
  rufloSwarmSubscriptionsTable,
  rufloSwarmsTable,
  rufloSwarmTasksTable,
} from "@workspace/db";
import type {
  RufloAgent,
  RufloBlackboardEntry,
  RufloConsensus,
  RufloSwarm,
  RufloSwarmEvent,
  RufloSwarmMessage,
  RufloSwarmRepository,
  RufloSwarmSubscription,
  RufloSwarmTask,
} from "./ruflo-swarm";
import { RufloSwarmError } from "./ruflo-swarm";

export class DatabaseRufloSwarmRepository implements RufloSwarmRepository {
  async createSwarm(value: RufloSwarm): Promise<RufloSwarm> {
    const [row] = await db.insert(rufloSwarmsTable).values({
      id: value.id, userId: value.userId, sessionId: value.sessionId, projectId: value.projectId,
      topology: value.topology, status: value.status, leaderAgentId: value.leaderAgentId ?? null, limits: value.limits, revision: value.revision,
      createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt),
    }).returning();
    return toSwarm(row);
  }

  async getSwarm(userId: string, swarmId: string): Promise<RufloSwarm | undefined> {
    const [row] = await db.select().from(rufloSwarmsTable).where(and(eq(rufloSwarmsTable.id, swarmId), eq(rufloSwarmsTable.userId, userId))).limit(1);
    return row ? toSwarm(row) : undefined;
  }

  async updateSwarm(value: RufloSwarm): Promise<RufloSwarm> {
    const [row] = await db.update(rufloSwarmsTable).set({
      topology: value.topology, status: value.status, leaderAgentId: value.leaderAgentId ?? null, limits: value.limits, revision: value.revision, updatedAt: new Date(value.updatedAt),
    }).where(eq(rufloSwarmsTable.id, value.id)).returning();
    return toSwarm(row);
  }

  async listAgents(swarmId: string): Promise<RufloAgent[]> {
    return (await db.select().from(rufloAgentsTable).where(eq(rufloAgentsTable.swarmId, swarmId)).orderBy(asc(rufloAgentsTable.createdAt))).map(toAgent);
  }

  async getAgent(swarmId: string, agentId: string): Promise<RufloAgent | undefined> {
    const [row] = await db.select().from(rufloAgentsTable).where(and(eq(rufloAgentsTable.swarmId, swarmId), eq(rufloAgentsTable.id, agentId))).limit(1);
    return row ? toAgent(row) : undefined;
  }

  async createAgent(value: RufloAgent): Promise<RufloAgent> {
    const [row] = await db.insert(rufloAgentsTable).values(agentValues(value)).returning();
    return toAgent(row);
  }

  async updateAgent(value: RufloAgent): Promise<RufloAgent> {
    const [row] = await db.update(rufloAgentsTable).set(agentValues(value)).where(eq(rufloAgentsTable.id, value.id)).returning();
    return toAgent(row);
  }

  async createMessage(value: RufloSwarmMessage): Promise<RufloSwarmMessage> {
    const [row] = await db.insert(rufloSwarmMessagesTable).values({
      id: value.id, swarmId: value.swarmId, fromAgentId: value.fromAgentId, toAgentId: value.toAgentId, type: value.type, payload: value.payload,
      status: value.status, deliveredAt: dateOrNull(value.deliveredAt), acknowledgedAt: dateOrNull(value.acknowledgedAt), createdAt: new Date(value.createdAt),
    }).returning();
    return toMessage(row);
  }

  async listMailbox(swarmId: string, agentId: string, limit: number): Promise<RufloSwarmMessage[]> {
    return (await db.select().from(rufloSwarmMessagesTable).where(and(eq(rufloSwarmMessagesTable.swarmId, swarmId), eq(rufloSwarmMessagesTable.toAgentId, agentId))).orderBy(desc(rufloSwarmMessagesTable.createdAt)).limit(limit)).reverse().map(toMessage);
  }

  async getMessage(swarmId: string, messageId: string): Promise<RufloSwarmMessage | undefined> {
    const [row] = await db.select().from(rufloSwarmMessagesTable).where(and(eq(rufloSwarmMessagesTable.swarmId, swarmId), eq(rufloSwarmMessagesTable.id, messageId))).limit(1);
    return row ? toMessage(row) : undefined;
  }

  async updateMessage(value: RufloSwarmMessage): Promise<RufloSwarmMessage> {
    const [row] = await db.update(rufloSwarmMessagesTable).set({
      status: value.status, deliveredAt: dateOrNull(value.deliveredAt), acknowledgedAt: dateOrNull(value.acknowledgedAt),
    }).where(eq(rufloSwarmMessagesTable.id, value.id)).returning();
    return toMessage(row);
  }

  async getBlackboard(swarmId: string, namespace: string, key: string): Promise<RufloBlackboardEntry | undefined> {
    const [row] = await db.select().from(rufloBlackboardTable).where(and(eq(rufloBlackboardTable.swarmId, swarmId), eq(rufloBlackboardTable.namespace, namespace), eq(rufloBlackboardTable.key, key))).limit(1);
    return row ? toBlackboard(row) : undefined;
  }

  async listBlackboard(swarmId: string, namespace?: string): Promise<RufloBlackboardEntry[]> {
    return (await db.select().from(rufloBlackboardTable).where(namespace ? and(eq(rufloBlackboardTable.swarmId, swarmId), eq(rufloBlackboardTable.namespace, namespace)) : eq(rufloBlackboardTable.swarmId, swarmId)).orderBy(asc(rufloBlackboardTable.namespace), asc(rufloBlackboardTable.key))).map(toBlackboard);
  }

  async upsertBlackboard(value: RufloBlackboardEntry, expectedVersion?: number): Promise<RufloBlackboardEntry> {
    const [row] = await db.insert(rufloBlackboardTable).values({
      id: value.id, swarmId: value.swarmId, namespace: value.namespace, key: value.key, value: value.value, version: value.version,
      updatedByAgentId: value.updatedByAgentId, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt),
    }).onConflictDoUpdate({
      target: [rufloBlackboardTable.swarmId, rufloBlackboardTable.namespace, rufloBlackboardTable.key],
      set: { value: value.value, version: value.version, updatedByAgentId: value.updatedByAgentId, updatedAt: new Date(value.updatedAt) },
      where: expectedVersion === undefined ? undefined : eq(rufloBlackboardTable.version, expectedVersion),
    }).returning();
    if (!row) throw new RufloSwarmError("context_conflict", "Shared context changed before this write was committed.");
    return toBlackboard(row);
  }

  async createSubscription(value: RufloSwarmSubscription): Promise<RufloSwarmSubscription> {
    const [row] = await db.insert(rufloSwarmSubscriptionsTable).values({
      id: value.id, swarmId: value.swarmId, agentId: value.agentId, eventType: value.eventType, createdAt: new Date(value.createdAt),
    }).onConflictDoNothing().returning();
    if (row) return toSubscription(row);
    const [existing] = await db.select().from(rufloSwarmSubscriptionsTable).where(and(eq(rufloSwarmSubscriptionsTable.agentId, value.agentId), eq(rufloSwarmSubscriptionsTable.eventType, value.eventType))).limit(1);
    if (!existing) throw new Error("Unable to create Ruflo swarm subscription.");
    return toSubscription(existing);
  }

  async listSubscriptions(swarmId: string, agentId: string): Promise<RufloSwarmSubscription[]> {
    return (await db.select().from(rufloSwarmSubscriptionsTable).where(and(eq(rufloSwarmSubscriptionsTable.swarmId, swarmId), eq(rufloSwarmSubscriptionsTable.agentId, agentId)))).map(toSubscription);
  }

  async createEvent(value: RufloSwarmEvent): Promise<RufloSwarmEvent> {
    const [row] = await db.transaction(async (tx) => {
      const [{ maxSequence }] = await tx.select({ maxSequence: sql<number>`coalesce(max(${rufloSwarmEventsTable.sequence}), 0)` }).from(rufloSwarmEventsTable).where(eq(rufloSwarmEventsTable.swarmId, value.swarmId));
      return tx.insert(rufloSwarmEventsTable).values({
        id: value.id, swarmId: value.swarmId, sequence: Number(maxSequence ?? 0) + 1, type: value.type, payload: value.payload, createdAt: new Date(value.createdAt),
      }).returning();
    });
    return toEvent(row);
  }

  async listEvents(swarmId: string, afterSequence: number, limit: number): Promise<RufloSwarmEvent[]> {
    return (await db.select().from(rufloSwarmEventsTable).where(and(eq(rufloSwarmEventsTable.swarmId, swarmId), gt(rufloSwarmEventsTable.sequence, afterSequence))).orderBy(asc(rufloSwarmEventsTable.sequence)).limit(limit)).map(toEvent);
  }

  async createTask(value: RufloSwarmTask): Promise<RufloSwarmTask> {
    const [row] = await db.insert(rufloSwarmTasksTable).values(taskValues(value)).returning();
    return toTask(row);
  }

  async getTask(swarmId: string, taskId: string): Promise<RufloSwarmTask | undefined> {
    const [row] = await db.select().from(rufloSwarmTasksTable).where(and(eq(rufloSwarmTasksTable.swarmId, swarmId), eq(rufloSwarmTasksTable.id, taskId))).limit(1);
    return row ? toTask(row) : undefined;
  }

  async listTasks(swarmId: string): Promise<RufloSwarmTask[]> {
    return (await db.select().from(rufloSwarmTasksTable).where(eq(rufloSwarmTasksTable.swarmId, swarmId)).orderBy(asc(rufloSwarmTasksTable.createdAt))).map(toTask);
  }

  async updateTask(value: RufloSwarmTask): Promise<RufloSwarmTask> {
    const [row] = await db.update(rufloSwarmTasksTable).set(taskValues(value)).where(eq(rufloSwarmTasksTable.id, value.id)).returning();
    return toTask(row);
  }

  async createConsensus(value: RufloConsensus): Promise<RufloConsensus> {
    const [row] = await db.insert(rufloConsensusTable).values({
      id: value.id, swarmId: value.swarmId, type: value.type, payload: value.payload, strategy: value.strategy, voterAgentIds: value.voterAgentIds,
      votes: value.votes, status: value.status, decision: value.decision ?? null, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt),
    }).returning();
    return toConsensus(row);
  }

  async getConsensus(swarmId: string, consensusId: string): Promise<RufloConsensus | undefined> {
    const [row] = await db.select().from(rufloConsensusTable).where(and(eq(rufloConsensusTable.swarmId, swarmId), eq(rufloConsensusTable.id, consensusId))).limit(1);
    return row ? toConsensus(row) : undefined;
  }

  async updateConsensus(value: RufloConsensus): Promise<RufloConsensus> {
    const [row] = await db.update(rufloConsensusTable).set({
      votes: value.votes, status: value.status, decision: value.decision ?? null, updatedAt: new Date(value.updatedAt),
    }).where(eq(rufloConsensusTable.id, value.id)).returning();
    return toConsensus(row);
  }

  async recoverExpired(now: string): Promise<{ agents: number; tasks: number }> {
    const timestamp = new Date(now);
    const expiredAgents = await db.update(rufloAgentsTable).set({ status: "expired", updatedAt: timestamp }).where(and(lt(rufloAgentsTable.leaseExpiresAt, timestamp), sql`${rufloAgentsTable.status} in ('active', 'busy')`)).returning({ id: rufloAgentsTable.id });
    const expiredTasks = await db.update(rufloSwarmTasksTable).set({ status: "pending", leaseOwnerAgentId: null, leaseExpiresAt: null, updatedAt: timestamp }).where(and(lt(rufloSwarmTasksTable.leaseExpiresAt, timestamp), eq(rufloSwarmTasksTable.status, "in_progress"))).returning({ id: rufloSwarmTasksTable.id });
    return { agents: expiredAgents.length, tasks: expiredTasks.length };
  }
}

export const rufloSwarmRepository = new DatabaseRufloSwarmRepository();

function toSwarm(row: typeof rufloSwarmsTable.$inferSelect | undefined): RufloSwarm {
  if (!row) throw new Error("Ruflo swarm record was not returned.");
  return { ...row, leaderAgentId: row.leaderAgentId ?? undefined, limits: row.limits as RufloSwarm["limits"], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function toAgent(row: typeof rufloAgentsTable.$inferSelect): RufloAgent {
  return { ...row, role: row.role as RufloAgent["role"], parentId: row.parentId ?? undefined, capabilities: row.capabilities as string[], metadata: row.metadata as Record<string, unknown>, credentialNonce: row.credentialNonce, lastHeartbeatAt: row.lastHeartbeatAt?.toISOString(), leaseExpiresAt: row.leaseExpiresAt?.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function toMessage(row: typeof rufloSwarmMessagesTable.$inferSelect): RufloSwarmMessage {
  return { ...row, payload: row.payload as Record<string, unknown>, createdAt: row.createdAt.toISOString(), deliveredAt: row.deliveredAt?.toISOString(), acknowledgedAt: row.acknowledgedAt?.toISOString() };
}
function toBlackboard(row: typeof rufloBlackboardTable.$inferSelect): RufloBlackboardEntry {
  return { ...row, value: row.value, updatedByAgentId: row.updatedByAgentId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function toSubscription(row: typeof rufloSwarmSubscriptionsTable.$inferSelect): RufloSwarmSubscription {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
function toEvent(row: typeof rufloSwarmEventsTable.$inferSelect): RufloSwarmEvent {
  return { ...row, payload: row.payload as Record<string, unknown>, createdAt: row.createdAt.toISOString() };
}
function toTask(row: typeof rufloSwarmTasksTable.$inferSelect): RufloSwarmTask {
  return { ...row, description: row.description ?? undefined, assignedAgentId: row.assignedAgentId ?? undefined, payload: row.payload as Record<string, unknown>, result: row.result ?? undefined, error: row.error ?? undefined, leaseOwnerAgentId: row.leaseOwnerAgentId ?? undefined, leaseExpiresAt: row.leaseExpiresAt?.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function toConsensus(row: typeof rufloConsensusTable.$inferSelect): RufloConsensus {
  return { ...row, payload: row.payload as Record<string, unknown>, strategy: row.strategy as RufloConsensus["strategy"], voterAgentIds: row.voterAgentIds as string[], votes: row.votes as RufloConsensus["votes"], decision: row.decision ?? undefined, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function dateOrNull(value: string | undefined): Date | null { return value ? new Date(value) : null; }
function agentValues(value: RufloAgent) {
  return {
    id: value.id, swarmId: value.swarmId, userId: value.userId, name: value.name, type: value.type, role: value.role, parentId: value.parentId ?? null,
    capabilities: value.capabilities, metadata: value.metadata, credentialNonce: value.credentialNonce, status: value.status,
    lastHeartbeatAt: dateOrNull(value.lastHeartbeatAt), leaseExpiresAt: dateOrNull(value.leaseExpiresAt), createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt),
  };
}
function taskValues(value: RufloSwarmTask) {
  return {
    id: value.id, swarmId: value.swarmId, sessionId: value.sessionId, title: value.title, description: value.description ?? null, status: value.status,
    assignedAgentId: value.assignedAgentId ?? null, payload: value.payload, result: value.result ?? null, error: value.error ?? null,
    leaseOwnerAgentId: value.leaseOwnerAgentId ?? null, leaseExpiresAt: dateOrNull(value.leaseExpiresAt), attempts: value.attempts, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt),
  };
}