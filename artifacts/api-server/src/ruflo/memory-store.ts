import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { rufloMemoryTable } from "@workspace/db/schema";
import {
  MAX_RUFLO_PERSISTED_MEMORY_FACTS,
} from "./memory-policy";
import { formatMemoryContext, MAX_RUFLO_MEMORY_CONTEXT_CHARS, MAX_RUFLO_MEMORY_FACTS, sanitizeMemoryFact } from "./memory-policy";
import type {
  CreateRufloMemoryInput,
  RufloMemory,
  RufloMemoryKind,
} from "./types";

export {
  formatMemoryContext,
  MAX_RUFLO_MEMORY_CONTEXT_CHARS,
  MAX_RUFLO_MEMORY_FACT_CHARS,
  MAX_RUFLO_MEMORY_FACTS,
  sanitizeMemoryFact,
} from "./memory-policy";

export function projectMemoryKey(input: {
  projectId: string;
  repository?: { owner: string; name: string; branch: string };
}): string {
  if (input.repository) {
    return `github:${input.repository.owner}/${input.repository.name}#${input.repository.branch}`.slice(0, 300);
  }
  return `workspace:${input.projectId}`.slice(0, 300);
}

export class RufloMemoryStore {
  async listMemory(userId: string, projectKey: string): Promise<RufloMemory[]> {
    const rows = await db
      .select()
      .from(rufloMemoryTable)
      .where(and(eq(rufloMemoryTable.userId, userId), eq(rufloMemoryTable.projectKey, projectKey)))
      .orderBy(desc(rufloMemoryTable.updatedAt))
      .limit(MAX_RUFLO_MEMORY_FACTS * 3);

    const result: RufloMemory[] = [];
    let chars = 0;
    for (const row of rows) {
      const fact = sanitizeMemoryFact(row.fact);
      if (!fact || chars + fact.length > MAX_RUFLO_MEMORY_CONTEXT_CHARS) continue;
      result.push({ ...row, fact });
      chars += fact.length;
      if (result.length >= MAX_RUFLO_MEMORY_FACTS) break;
    }
    return result;
  }

  async remember(userId: string, input: CreateRufloMemoryInput): Promise<RufloMemory | undefined> {
    const projectKey = input.projectKey.trim().slice(0, 300);
    const fact = sanitizeMemoryFact(input.fact);
    if (!projectKey || !fact) return undefined;

    const [existing] = await db
      .select()
      .from(rufloMemoryTable)
      .where(
        and(
          eq(rufloMemoryTable.userId, userId),
          eq(rufloMemoryTable.projectKey, projectKey),
          eq(rufloMemoryTable.kind, input.kind),
          eq(rufloMemoryTable.fact, fact),
        ),
      )
      .limit(1);
    if (existing) {
      const [updated] = await db
        .update(rufloMemoryTable)
        .set({ updatedAt: new Date(), sourceSessionId: input.sourceSessionId ?? existing.sourceSessionId })
        .where(eq(rufloMemoryTable.id, existing.id))
        .returning();
      await this.trimProject(userId, projectKey);
      return updated;
    }

    const [created] = await db
      .insert(rufloMemoryTable)
      .values({
        id: randomUUID(),
        userId,
        projectKey,
        kind: input.kind as RufloMemoryKind,
        fact,
        sourceSessionId: input.sourceSessionId ?? null,
      })
      .returning();
    await this.trimProject(userId, projectKey);
    return created;
  }

  private async trimProject(userId: string, projectKey: string): Promise<void> {
    const rows = await db
      .select({ id: rufloMemoryTable.id })
      .from(rufloMemoryTable)
      .where(and(eq(rufloMemoryTable.userId, userId), eq(rufloMemoryTable.projectKey, projectKey)))
      .orderBy(desc(rufloMemoryTable.updatedAt))
      .limit(1_000);
    const staleIds = rows.slice(MAX_RUFLO_PERSISTED_MEMORY_FACTS).map((row) => row.id);
    if (staleIds.length) await db.delete(rufloMemoryTable).where(inArray(rufloMemoryTable.id, staleIds));
  }
}

export const rufloMemoryStore = new RufloMemoryStore();