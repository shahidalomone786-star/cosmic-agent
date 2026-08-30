import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  rufloActivitiesTable,
  rufloSessionsTable,
  rufloTasksTable,
} from "@workspace/db";
import type {
  CreateRufloActivityInput,
  CreateRufloSessionInput,
  CreateRufloTaskInput,
  RufloActivity,
  RufloSession,
  RufloTask,
} from "./types";
import type { RufloSessionStore } from "./session-store";

export class RufloSessionNotFoundError extends Error {
  constructor() {
    super("Ruflo session was not found for the authenticated user.");
    this.name = "RufloSessionNotFoundError";
  }
}

export class RufloTaskNotFoundError extends Error {
  constructor() {
    super("Ruflo task was not found for the authenticated user.");
    this.name = "RufloTaskNotFoundError";
  }
}

export class DatabaseRufloSessionStore implements RufloSessionStore {
  async createSession(userId: string, input: CreateRufloSessionInput): Promise<RufloSession> {
    const [row] = await db
      .insert(rufloSessionsTable)
      .values({
        id: randomUUID(),
        userId,
        goal: input.goal,
      })
      .returning();
    if (!row) throw new Error("Unable to create Ruflo session.");
    return row;
  }

  async getSession(userId: string, sessionId: string): Promise<RufloSession | undefined> {
    const [row] = await db
      .select()
      .from(rufloSessionsTable)
      .where(and(eq(rufloSessionsTable.id, sessionId), eq(rufloSessionsTable.userId, userId)))
      .limit(1);
    return row;
  }

  async updateSessionStatus(userId: string, sessionId: string, status: RufloSession["status"]): Promise<RufloSession> {
    await this.requireOwnedSession(userId, sessionId);
    const [row] = await db
      .update(rufloSessionsTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(rufloSessionsTable.id, sessionId), eq(rufloSessionsTable.userId, userId)))
      .returning();
    if (!row) throw new RufloSessionNotFoundError();
    return row;
  }

  async listSessions(userId: string): Promise<RufloSession[]> {
    return db
      .select()
      .from(rufloSessionsTable)
      .where(eq(rufloSessionsTable.userId, userId))
      .orderBy(desc(rufloSessionsTable.createdAt));
  }

  async createTask(userId: string, input: CreateRufloTaskInput): Promise<RufloTask> {
    await this.requireOwnedSession(userId, input.sessionId);
    const [row] = await db
      .insert(rufloTasksTable)
      .values({
        id: randomUUID(),
        sessionId: input.sessionId,
        title: input.title,
        description: input.description ?? null,
        position: input.position ?? 0,
      })
      .returning();
    if (!row) throw new Error("Unable to create Ruflo task.");
    return row;
  }

  async listTasks(userId: string, sessionId: string): Promise<RufloTask[]> {
    await this.requireOwnedSession(userId, sessionId);
    return db
      .select()
      .from(rufloTasksTable)
      .where(eq(rufloTasksTable.sessionId, sessionId))
      .orderBy(asc(rufloTasksTable.position), asc(rufloTasksTable.createdAt));
  }

  async createActivity(userId: string, input: CreateRufloActivityInput): Promise<RufloActivity> {
    await this.requireOwnedSession(userId, input.sessionId);
    if (input.taskId) await this.requireOwnedTask(userId, input.sessionId, input.taskId);

    const [row] = await db
      .insert(rufloActivitiesTable)
      .values({
        id: randomUUID(),
        sessionId: input.sessionId,
        taskId: input.taskId ?? null,
        kind: input.kind,
        message: input.message,
      })
      .returning();
    if (!row) throw new Error("Unable to create Ruflo activity.");
    return row;
  }

  async listActivities(userId: string, sessionId: string): Promise<RufloActivity[]> {
    await this.requireOwnedSession(userId, sessionId);
    return db
      .select()
      .from(rufloActivitiesTable)
      .where(eq(rufloActivitiesTable.sessionId, sessionId))
      .orderBy(asc(rufloActivitiesTable.createdAt));
  }

  private async requireOwnedSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.getSession(userId, sessionId);
    if (!session) throw new RufloSessionNotFoundError();
  }

  private async requireOwnedTask(userId: string, sessionId: string, taskId: string): Promise<void> {
    const [row] = await db
      .select({ id: rufloTasksTable.id })
      .from(rufloTasksTable)
      .innerJoin(rufloSessionsTable, eq(rufloSessionsTable.id, rufloTasksTable.sessionId))
      .where(
        and(
          eq(rufloTasksTable.id, taskId),
          eq(rufloTasksTable.sessionId, sessionId),
          eq(rufloSessionsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!row) throw new RufloTaskNotFoundError();
  }
}

export const rufloSessionStore = new DatabaseRufloSessionStore();