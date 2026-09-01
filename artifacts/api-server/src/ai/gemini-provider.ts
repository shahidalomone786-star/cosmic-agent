import type {
  AiChatRequest,
  AiChatResponse,
  AiModel,
  AiProvider,
  ProviderHealth,
} from "./ai-provider";
import type { AiRequestRole } from "./ai-provider";
import { GroqProviderError } from "./groq-provider";
import { geminiKeyManager, type GeminiKeyManager } from "./gemini-key-manager";
import { GEMINI_MODEL_ID } from "./model-registry";
import { logger } from "../lib/logger";
import { recordProviderMetric } from "./provider-metrics";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 12;
const RETRY_BASE_DELAY_MS = 25;
const RETRY_MAX_DELAY_MS = 500;

type GeminiResponse = {
  responseId?: string;
  modelVersion?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

export class GeminiProvider implements AiProvider {
  readonly id = "gemini" as const;

  constructor(
    private readonly models: AiModel[],
    private readonly keyManager: GeminiKeyManager = geminiKeyManager,
  ) {}

  getModels(): AiModel[] {
    return this.models.map((model) => ({ ...model, capabilities: [...model.capabilities] }));
  }

  healthCheck(): ProviderHealth {
    const status = this.keyManager.getStatus();
    return {
      available: status.available > 0,
      configured: status.configured > 0,
      message: status.configured === 0
        ? "No Gemini provider keys are configured."
        : status.available > 0
          ? "Gemini is configured server-side."
          : "All configured Gemini keys are temporarily unavailable.",
    };
  }

  async chat(request: AiChatRequest): Promise<AiChatResponse> {
    const result = await this.requestWithFailover(request, false);
    return this.toResponse(result, request.model);
  }

  async stream(request: AiChatRequest, onToken: (token: string) => void): Promise<AiChatResponse> {
    const result = await this.requestWithFailover(request, true, onToken);
    return this.toResponse(result, request.model);
  }

  private async requestWithFailover(
    request: AiChatRequest,
    stream: boolean,
    onToken?: (token: string) => void,
  ): Promise<GeminiResponse> {
    const configured = this.keyManager.getStatus().configured;
    if (configured === 0) {
      throw new GroqProviderError("not_configured", "Gemini is not configured yet.");
    }

    let lastError: GroqProviderError | undefined;
    let emitted = false;
    let attemptsMade = 0;
    let rateLimited = false;
    const startedAt = Date.now();
    for (let attempt = 0; attempt < Math.min(configured, MAX_ATTEMPTS); attempt += 1) {
      const lease = this.keyManager.acquire();
      if (!lease) break;
      attemptsMade += 1;
      try {
        const result = await this.request(lease.secret, request, stream, (token) => {
          emitted = true;
          onToken?.(token);
        });
        if (!extractText(result).trim()) {
          throw new GroqProviderError("incomplete_response", "Gemini returned an incomplete response.", true);
        }
        this.keyManager.markSuccess(lease.id);
        recordProviderMetric({
          provider: "gemini",
          role: request.role as AiRequestRole | undefined,
          keySlot: lease.id,
          success: true,
          retryCount: attempt,
          rateLimited,
          approximateInputChars: approximateRequestChars(request),
          approximateOutputChars: extractText(result).length,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        lastError = error instanceof GroqProviderError
          ? error
          : new GroqProviderError("temporary_failure", "Gemini request failed.", true);
        if (lastError.code === "rate_limited") {
          rateLimited = true;
          this.keyManager.markRateLimited(lease.id);
        }
        else if (lastError.code === "invalid_configuration") this.keyManager.markFailure(lease.id, true);
        else if (lastError.retryable) this.keyManager.markFailure(lease.id);
        recordProviderMetric({
          provider: "gemini",
          role: request.role as AiRequestRole | undefined,
          keySlot: lease.id,
          success: false,
          retryCount: attempt,
          rateLimited: lastError.code === "rate_limited",
          approximateInputChars: approximateRequestChars(request),
          approximateOutputChars: 0,
          durationMs: Date.now() - startedAt,
        });
        if (!lastError.retryable || (stream && emitted)) throw lastError;
        if (attempt + 1 < Math.min(configured, MAX_ATTEMPTS)) {
          await waitForRetry(attempt);
        }
      }
    }
    if (attemptsMade > 0 && !lastError) {
      throw new GroqProviderError("temporary_failure", "Gemini keys are temporarily unavailable. Please retry later.", true);
    }
    throw lastError
      ? new GroqProviderError("temporary_failure", "All configured Gemini keys are temporarily unavailable. Please retry later.", true)
      : new GroqProviderError("temporary_failure", "All configured Gemini keys are temporarily unavailable. Please retry later.", true);
  }

  private async request(
    key: string,
    request: AiChatRequest,
    stream: boolean,
    onToken?: (token: string) => void,
  ): Promise<GeminiResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const action = stream ? "streamGenerateContent?alt=sse&key" : "generateContent?key";
      const modelId = request.model || GEMINI_MODEL_ID;
      const endpoint = `${GEMINI_BASE_URL}/${encodeURIComponent(modelId)}:${action}=${encodeURIComponent(key)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(toGeminiBody(request)),
        signal: controller.signal,
      });
       logger.info({ provider: "gemini", model: modelId, status: response.status }, "Gemini provider response");
      if (!response.ok) throw await this.toProviderError(response);
      if (stream) return this.readStream(response, onToken ?? (() => undefined));
      return await response.json() as GeminiResponse;
    } catch (error) {
      if (error instanceof GroqProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new GroqProviderError("timeout", "Gemini timed out.", true);
      }
      throw new GroqProviderError("temporary_failure", "Gemini is temporarily unavailable.", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readStream(response: Response, onToken: (token: string) => void): Promise<GeminiResponse> {
    if (!response.body) throw new GroqProviderError("temporary_failure", "Gemini returned no stream.", true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let responseId: string | undefined;
    let modelVersion: string | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const chunk = parseJson(line.slice(5).trim()) as GeminiResponse | null;
        if (!chunk) continue;
        responseId = chunk.responseId ?? responseId;
        modelVersion = chunk.modelVersion ?? modelVersion;
        const token = extractText(chunk);
        if (token) {
          content += token;
          onToken(token);
        }
      }
    }
    return { responseId, modelVersion, candidates: [{ content: { parts: [{ text: content }] } }] };
  }

  private async toProviderError(response: Response): Promise<GroqProviderError> {
    const body = parseJson(await response.text()) as { error?: { message?: string } } | null;
    const detail = body?.error?.message ?? "";
    if (response.status === 401 || (response.status === 403 && !/(quota|rate limit|resource exhausted|capacity)/i.test(detail))) {
      return new GroqProviderError("invalid_configuration", "Gemini provider configuration is invalid.");
    }
    if (response.status === 404) {
      return new GroqProviderError("model_unavailable", "The selected Gemini model is unavailable.");
    }
    if (response.status === 429 || (response.status === 403 && /(quota|rate limit|resource exhausted|capacity)/i.test(detail))) return new GroqProviderError("rate_limited", "Gemini is rate limited.", true);
    if (response.status === 408) return new GroqProviderError("temporary_failure", "Gemini is temporarily unavailable.", true);
    if (response.status >= 500) return new GroqProviderError("temporary_failure", "Gemini is temporarily unavailable.", true);
    if (response.status === 400 && /(context|token|prompt).*(limit|length|too large)|maximum context/i.test(detail)) {
      return new GroqProviderError("context_limit", "The request exceeded the model context limit.", true);
    }
    return new GroqProviderError("provider_error", "Gemini rejected the request.");
  }

  private toResponse(result: GeminiResponse, requestedModel: string): AiChatResponse {
    return {
      id: result.responseId ?? `gemini-${Date.now()}`,
      model: result.modelVersion ?? requestedModel,
      content: extractText(result),
      provider: "gemini",
      usage: result.usageMetadata && toUsage(
        result.usageMetadata.promptTokenCount,
        result.usageMetadata.candidatesTokenCount,
        result.usageMetadata.totalTokenCount,
      ),
    };
  }
}

function toUsage(inputTokens?: number, outputTokens?: number, totalTokens?: number) {
  if (![inputTokens, outputTokens, totalTokens].every((value) => Number.isFinite(value))) return undefined;
  return {
    inputTokens: Math.max(0, Math.floor(inputTokens!)),
    outputTokens: Math.max(0, Math.floor(outputTokens!)),
    totalTokens: Math.max(0, Math.floor(totalTokens!)),
    exact: true,
  };
}

function toGeminiBody(request: AiChatRequest) {
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: request.messages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    generationConfig: {
      ...(request.temperature == null ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens == null ? {} : { maxOutputTokens: request.maxOutputTokens }),
    },
  };
}

function extractText(response: GeminiResponse): string {
  return response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function approximateRequestChars(request: AiChatRequest): number {
  return request.messages.reduce((total, message) => total + message.content.length, 0);
}

async function waitForRetry(attempt: number): Promise<void> {
  const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** attempt));
  await new Promise((resolve) => setTimeout(resolve, delay));
}