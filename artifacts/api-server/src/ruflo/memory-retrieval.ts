import type { RufloMemory, RufloMemoryKind } from "./types";

export type RufloMemoryMatch = RufloMemory & {
  relevance: number;
  semanticScore: number;
  keywordScore: number;
  recencyScore: number;
  projectScore: number;
  sessionScore: number;
};

export type MemoryRetrievalOptions = {
  query?: string;
  sourceSessionId?: string;
  kinds?: readonly RufloMemoryKind[];
  limit?: number;
  now?: Date;
};

const MAX_RETRIEVAL_LIMIT = 24;

export function rankMemoryCandidates(
  memories: readonly RufloMemory[],
  queryEmbedding: readonly number[] | undefined,
  options: MemoryRetrievalOptions = {},
): RufloMemoryMatch[] {
  const query = (options.query ?? "").trim().slice(0, 500);
  const queryTokens = tokenize(query);
  const allowedKinds = options.kinds ? new Set(options.kinds) : undefined;
  const now = options.now ?? new Date();
  const ranked = memories
    .filter((memory) => !allowedKinds || allowedKinds.has(memory.kind))
    .map((memory) => {
      const semanticScore = queryEmbedding ? cosineSimilarity(queryEmbedding, parseStoredEmbedding(memory.embedding)) : 0;
      const keywordScore = keywordMatchScore(memory, queryTokens);
      const recencyScore = recency(memory.lastUsedAt ?? memory.updatedAt, now);
      const projectScore = 1;
      const sessionScore = options.sourceSessionId && memory.sourceSessionId === options.sourceSessionId ? 1 : 0;
      const metadataScore = (clamp(memory.importance, 0, 100) / 100) * 0.15
        + clamp(memory.confidence, 0, 1) * 0.15
        + recencyScore * 0.15
        + sessionScore * 0.1;
      const evidenceScore = queryTokens.length || queryEmbedding ? semanticScore * 0.35 + keywordScore * 0.25 : 0;
      const relevance = clamp(metadataScore + evidenceScore + projectScore * 0.1, 0, 1);
      return {
        ...memory,
        relevance,
        semanticScore,
        keywordScore,
        recencyScore,
        projectScore,
        sessionScore,
      };
    })
    .filter((memory) => !query || memory.keywordScore > 0 || memory.semanticScore > 0)
    .sort((a, b) => b.relevance - a.relevance || b.updatedAt.getTime() - a.updatedAt.getTime());

  return deduplicateMemoryMatches(ranked).slice(0, Math.max(1, Math.min(options.limit ?? 12, MAX_RETRIEVAL_LIMIT)));
}

export function deduplicateMemoryMatches(memories: readonly RufloMemoryMatch[]): RufloMemoryMatch[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const key = `${memory.kind}:${canonicalFact(memory.fact)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function canonicalFact(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\[redacted(?:-[^\]]+)?\]/g, "[secret]")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1))];
}

export function keywordMatchScore(memory: Pick<RufloMemory, "kind" | "fact">, queryTokens: readonly string[]): number {
  if (!queryTokens.length) return 0;
  const haystack = tokenize(`${memory.kind} ${memory.fact}`);
  const matches = queryTokens.filter((token) => haystack.includes(token)).length;
  return matches / queryTokens.length;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[] | undefined): number {
  if (!right || left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return clamp(dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)), 0, 1);
}

export function parseStoredEmbedding(value: string | null): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number" && Number.isFinite(item))
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function isObsoleteMemory(memory: Pick<RufloMemory, "importance" | "confidence" | "lastUsedAt" | "updatedAt" | "failureCount" | "successCount">, now = new Date()): boolean {
  const cutoff = now.getTime() - 90 * 86_400_000;
  return memory.importance <= 25
    && memory.confidence < 0.4
    && (memory.lastUsedAt ?? memory.updatedAt).getTime() < cutoff
    && memory.failureCount >= memory.successCount;
}

function recency(value: Date, now: Date): number {
  const ageDays = Math.max(0, now.getTime() - value.getTime()) / 86_400_000;
  return Math.exp(-ageDays / 45);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}