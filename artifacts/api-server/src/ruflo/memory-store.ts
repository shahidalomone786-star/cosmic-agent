import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, rufloMemoryTable } from "@workspace/db";
import {
  MAX_RUFLO_MEMORY_CONTEXT_CHARS,
  MAX_RUFLO_MEMORY_FACTS,
  MAX_RUFLO_PERSISTED_MEMORY_FACTS,
  sanitizeMemoryFact,
} from "./memory-policy";
import { createConfiguredEmbeddingProvider, type RufloEmbeddingProvider } from "./embedding-provider";
import {
  canonicalFact,
  isObsoleteMemory,
  rankMemoryCandidates,
  type MemoryRetrievalOptions,
  type RufloMemoryMatch,
} from "./memory-retrieval";
import type { CreateRufloMemoryInput, RufloMemory, RufloMemoryKind } from "./types";

export {
  formatMemoryContext,
  MAX_RUFLO_MEMORY_CONTEXT_CHARS,
  MAX_RUFLO_MEMORY_FACT_CHARS,
  MAX_RUFLO_MEMORY_FACTS,
  sanitizeMemoryFact,
} from "./memory-policy";
export { isObsoleteMemory, rankMemoryCandidates, type RufloMemoryMatch } from "./memory-retrieval";

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
  constructor(
    private readonly database = db,
    private readonly embeddingProvider: RufloEmbeddingProvider | undefined = createConfiguredEmbeddingProvider(),
  ) {}

  async listMemory(userId: string, projectKey: string): Promise<RufloMemory[]> {
    const rows = await this.database
      .select()
      .from(rufloMemoryTable)
      .where(and(eq(rufloMemoryTable.userId, userId), eq(rufloMemoryTable.projectKey, projectKey)))
      .orderBy(desc(rufloMemoryTable.updatedAt))
      .limit(MAX_RUFLO_MEMORY_FACTS * 4);
    return rows
      .map(normalizeMemory)
      .filter((row) => Boolean(sanitizeMemoryFact(row.fact)))
      .slice(0, MAX_RUFLO_MEMORY_FACTS);
  }

  async retrieveRelevant(
    userId: string,
    projectKey: string,
    options: MemoryRetrievalOptions = {},
  ): Promise<RufloMemoryMatch[]> {
    const query = options.query?.trim().slice(0, 500) ?? "";
    const rows = await this.database
      .select()
      .from(rufloMemoryTable)
      .where(and(eq(rufloMemoryTable.userId, userId), eq(rufloMemoryTable.projectKey, projectKey)))
      .orderBy(desc(rufloMemoryTable.updatedAt))
      .limit(MAX_RUFLO_PERSISTED_MEMORY_FACTS);
    const memories = rows.map(normalizeMemory);
    const queryEmbedding = query ? await this.tryEmbed(query) : undefined;
    const matches = rankMemoryCandidates(memories, queryEmbedding, options);
    if (matches.length) {
      await this.markUsed(matches.map((match) => match.id));
    }
    return matches;
  }

  async remember(userId: string, input: CreateRufloMemoryInput): Promise<RufloMemory | undefined> {
    const projectKey = input.projectKey.trim().slice(0, 300);
    const fact = sanitizeMemoryFact(input.fact);
    if (!projectKey || !fact) return undefined;

    const fingerprint = memoryFingerprint(input.kind, fact);
    const existingRows = await this.database
      .select()
      .from(rufloMemoryTable)
      .where(
        and(
          eq(rufloMemoryTable.userId, userId),
          eq(rufloMemoryTable.projectKey, projectKey),
          eq(rufloMemoryTable.kind, input.kind),
        ),
      )
      .limit(64);
    const existing = existingRows
      .map(normalizeMemory)
      .find((row) => row.fingerprint === fingerprint || canonicalFact(row.fact) === canonicalFact(fact));

    const now = new Date();
    const outcome = input.outcome ?? "neutral";
    if (existing) {
      const [updated] = await this.database
        .update(rufloMemoryTable)
        .set({
          updatedAt: now,
          lastUsedAt: now,
          sourceSessionId: input.sourceSessionId ?? existing.sourceSessionId,
          sourceTaskId: input.sourceTaskId ?? existing.sourceTaskId,
          fingerprint,
          importance: clampInteger(input.importance ?? existing.importance, 0, 100),
          confidence: clampNumber(input.confidence ?? existing.confidence, 0, 1),
          ...(outcome === "success" ? { successCount: sql`${rufloMemoryTable.successCount} + 1` } : {}),
          ...(outcome === "failure" ? { failureCount: sql`${rufloMemoryTable.failureCount} + 1` } : {}),
        })
        .where(eq(rufloMemoryTable.id, existing.id))
        .returning();
      await this.trimProject(userId, projectKey);
      return updated ? normalizeMemory(updated) : undefined;
    }

    const embedding = await this.tryEmbed(fact);
    const [created] = await this.database
      .insert(rufloMemoryTable)
      .values({
        id: randomUUID(),
        userId,
        projectKey,
        kind: input.kind as RufloMemoryKind,
        fact,
        sourceSessionId: input.sourceSessionId ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        fingerprint,
        importance: clampInteger(input.importance ?? defaultImportance(input.kind), 0, 100),
        confidence: clampNumber(input.confidence ?? 0.5, 0, 1),
        successCount: outcome === "success" ? 1 : 0,
        failureCount: outcome === "failure" ? 1 : 0,
        lastUsedAt: now,
        embedding: embedding ? JSON.stringify(embedding) : null,
        embeddingProvider: embedding ? this.embeddingProvider?.id ?? null : null,
        embeddingModel: embedding ? this.embeddingProvider?.model ?? null : null,
        verified: false,
      })
      .returning();
    await this.trimProject(userId, projectKey);
    return created ? normalizeMemory(created) : undefined;
  }

  async cleanup(userId: string, projectKey: string, maxDeletes = 12): Promise<number> {
    const rows = await this.database
      .select()
      .from(rufloMemoryTable)
      .where(and(eq(rufloMemoryTable.userId, userId), eq(rufloMemoryTable.projectKey, projectKey)))
      .orderBy(desc(rufloMemoryTable.updatedAt))
      .limit(MAX_RUFLO_PERSISTED_MEMORY_FACTS * 2);
    const obsolete = rows
      .map(normalizeMemory)
      .filter((row) => isObsoleteMemory(row))
      .slice(0, Math.max(0, Math.min(maxDeletes, 24)));
    if (obsolete.length) {
      await this.database.delete(rufloMemoryTable).where(inArray(rufloMemoryTable.id, obsolete.map((row) => row.id)));
    }
    return obsolete.length;
  }

  private async tryEmbed(input: string): Promise<number[] | undefined> {
    if (!this.embeddingProvider) return undefined;
    try {
      return await this.embeddingProvider.embed(input.slice(0, 2_000));
    } catch {
      return undefined;
    }
  }

  private async markUsed(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await this.database
      .update(rufloMemoryTable)
      .set({ lastUsedAt: new Date() })
      .where(inArray(rufloMemoryTable.id, ids))
      .catch(() => undefined);
  }

  private async trimProject(userId: string, projectKey: string): Promise<void> {
    const rows = await this.database
      .select({ id: rufloMemoryTable.id })
      .from(rufloMemoryTable)
      .where(and(eq(rufloMemoryTable.userId, userId), eq(rufloMemoryTable.projectKey, projectKey)))
      .orderBy(desc(rufloMemoryTable.importance), desc(rufloMemoryTable.updatedAt))
      .limit(MAX_RUFLO_PERSISTED_MEMORY_FACTS + 24);
    const staleIds = rows.slice(MAX_RUFLO_PERSISTED_MEMORY_FACTS).map((row) => row.id);
    if (staleIds.length) await this.database.delete(rufloMemoryTable).where(inArray(rufloMemoryTable.id, staleIds));
  }
}

function normalizeMemory(row: typeof rufloMemoryTable["$inferSelect"]): RufloMemory {
  return {
    ...row,
    sourceTaskId: row.sourceTaskId ?? null,
    fingerprint: row.fingerprint ?? null,
    importance: row.importance ?? 50,
    confidence: row.confidence ?? 0.5,
    successCount: row.successCount ?? 0,
    failureCount: row.failureCount ?? 0,
    lastUsedAt: row.lastUsedAt ?? null,
    embedding: row.embedding ?? null,
    embeddingProvider: row.embeddingProvider ?? null,
    embeddingModel: row.embeddingModel ?? null,
    verified: row.verified ?? false,
  };
}

function memoryFingerprint(kind: RufloMemoryKind, fact: string): string {
  return createHash("sha256").update(`${kind}:${canonicalFact(fact)}`).digest("hex");
}

function defaultImportance(kind: RufloMemoryKind): number {
  return kind === "warning" || kind === "failed_solution" || kind === "validation_problem" ? 70 : 55;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.round(clampNumber(value, min, max));
}

export const rufloMemoryStore = new RufloMemoryStore();