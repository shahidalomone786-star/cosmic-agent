import {
  MAX_RUFLO_EMBEDDING_DIMENSIONS,
  MAX_RUFLO_EMBEDDING_INPUT_CHARS,
} from "./memory-policy";

export interface RufloEmbeddingProvider {
  readonly id: string;
  readonly model: string;
  embed(input: string): Promise<number[]>;
}

type EmbeddingResponse = {
  embedding?: unknown;
  embeddings?: unknown;
  data?: Array<{ embedding?: unknown }>;
  vectors?: unknown;
};

const DEFAULT_TIMEOUT_MS = 3_500;
const MAX_RETRIES = 1;

/**
 * An optional OpenAI-compatible embedding endpoint. It is intentionally
 * disabled unless an endpoint is configured; Ruflo remains keyword-capable
 * without an embedding service.
 */
export class HttpRufloEmbeddingProvider implements RufloEmbeddingProvider {
  readonly id = "http";
  readonly model: string;

  constructor(
    private readonly endpoint: string,
    model = "text-embedding-3-small",
    private readonly apiKey?: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.model = model.slice(0, 120);
  }

  async embed(input: string): Promise<number[]> {
    const boundedInput = input.trim().slice(0, MAX_RUFLO_EMBEDDING_INPUT_CHARS);
    if (!boundedInput) throw new Error("Embedding input is empty.");
    let lastError: unknown = new Error("Embedding request failed.");
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ input: boundedInput, model: this.model }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Embedding provider returned HTTP ${response.status}.`);
        }
        const parsed = await response.json() as EmbeddingResponse;
        const embedding = parseEmbedding(parsed);
        if (!embedding) throw new Error("Embedding provider returned no valid vector.");
        return embedding;
      } catch (error) {
        lastError = error;
        if (attempt >= MAX_RETRIES) break;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`Embedding unavailable: ${lastError instanceof Error ? lastError.message : "provider failure"}`);
  }
}

export function createConfiguredEmbeddingProvider(): RufloEmbeddingProvider | undefined {
  const endpoint = process.env.RUFLO_EMBEDDING_ENDPOINT?.trim();
  if (!endpoint || !/^https:\/\//i.test(endpoint)) return undefined;
  return new HttpRufloEmbeddingProvider(
    endpoint,
    process.env.RUFLO_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    process.env.RUFLO_EMBEDDING_API_KEY,
  );
}

export function parseEmbedding(value: EmbeddingResponse): number[] | undefined {
  const candidate = value.embedding
    ?? value.embeddings
    ?? value.vectors
    ?? value.data?.[0]?.embedding;
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > MAX_RUFLO_EMBEDDING_DIMENSIONS) return undefined;
  const numbers = candidate.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return numbers.length === candidate.length ? numbers : undefined;
}