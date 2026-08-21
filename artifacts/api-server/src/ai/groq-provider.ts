import type {
  AiChatRequest,
  AiChatResponse,
  AiModel,
  AiProvider,
  ProviderHealth,
} from "./ai-provider";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 45_000;

type GroqChoice = {
  message?: { content?: string };
  delta?: { content?: string };
};

type GroqResponse = {
  id?: string;
  model?: string;
  choices?: GroqChoice[];
};

export class GroqProvider implements AiProvider {
  readonly id = "groq" as const;
  private nextKeyIndex = 0;

  constructor(private readonly models: AiModel[]) {}

  getModels(): AiModel[] {
    return this.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities],
    }));
  }

  healthCheck(): ProviderHealth {
    const keyCount = this.getKeys().length;
    return {
      available: keyCount > 0,
      configured: keyCount > 0,
      message:
        keyCount > 0
          ? "Groq is configured server-side."
          : "No Groq provider keys are configured.",
    };
  }

  async chat(request: AiChatRequest): Promise<AiChatResponse> {
    const result = await this.requestWithFailover(request, false);
    return this.toResponse(result);
  }

  async stream(
    request: AiChatRequest,
    onToken: (token: string) => void,
  ): Promise<AiChatResponse> {
    const result = await this.requestWithFailover(request, true, onToken);
    return this.toResponse(result);
  }

  private async requestWithFailover(
    request: AiChatRequest,
    stream: boolean,
    onToken?: (token: string) => void,
  ): Promise<GroqResponse> {
    const keys = this.getKeys();
    if (keys.length === 0) {
      throw new GroqProviderError(
        "not_configured",
        "The AI provider is not configured yet.",
      );
    }

    const attempts = Math.min(keys.length, MAX_ATTEMPTS);
    let lastError: GroqProviderError | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const key = this.takeNextKey(keys);
      try {
        return await this.request(key, request, stream, onToken);
      } catch (error) {
        lastError =
          error instanceof GroqProviderError
            ? error
            : new GroqProviderError("temporary_failure", "Provider request failed.");

        if (!lastError.retryable) {
          throw lastError;
        }
      }
    }

    throw (
      lastError ??
      new GroqProviderError("temporary_failure", "All configured provider keys are unavailable.")
    );
  }

  private async request(
    key: string,
    request: AiChatRequest,
    stream: boolean,
    onToken?: (token: string) => void,
  ): Promise<GroqResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? undefined,
          stream,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw await this.toProviderError(response);
      }

      if (stream) {
        return this.readStream(response, onToken ?? (() => undefined));
      }

      return (await response.json()) as GroqResponse;
    } catch (error) {
      if (error instanceof GroqProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new GroqProviderError("timeout", "The AI provider timed out.", true);
      }
      throw new GroqProviderError("temporary_failure", "The AI provider is temporarily unavailable.", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readStream(
    response: Response,
    onToken: (token: string) => void,
  ): Promise<GroqResponse> {
    if (!response.body) {
      throw new GroqProviderError("temporary_failure", "The provider returned no stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let id = "groq-stream";
    let model = "";
    let content = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as GroqResponse;
          id = chunk.id ?? id;
          model = chunk.model ?? model;
          const token = chunk.choices?.[0]?.delta?.content ?? "";
          if (token) {
            content += token;
            onToken(token);
          }
        } catch {
          // Ignore incomplete provider frames; the next frame may complete them.
        }
      }
    }

    return { id, model, choices: [{ message: { content } }] };
  }

  private async toProviderError(response: Response): Promise<GroqProviderError> {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      detail = "";
    }

    if (response.status === 401 || response.status === 403) {
      return new GroqProviderError("invalid_configuration", "The AI provider configuration is invalid.");
    }
    if (response.status === 404) {
      return new GroqProviderError("model_unavailable", "The selected model is unavailable.");
    }
    if (response.status === 429) {
      return new GroqProviderError("rate_limited", "The AI provider is rate limited.", true);
    }
    if (response.status >= 500) {
      return new GroqProviderError("temporary_failure", "The AI provider is temporarily unavailable.", true);
    }
    return new GroqProviderError(
      "provider_error",
      detail ? `The AI provider rejected the request: ${detail}` : "The AI provider rejected the request.",
    );
  }

  private getKeys(): string[] {
    return [1, 2, 3, 4, 5]
      .map((index) => process.env[`GROQ_API_KEY_${index}`]?.trim())
      .filter((key): key is string => Boolean(key));
  }

  private takeNextKey(keys: string[]): string {
    const key = keys[this.nextKeyIndex % keys.length];
    this.nextKeyIndex = (this.nextKeyIndex + 1) % keys.length;
    return key;
  }

  private toResponse(result: GroqResponse): AiChatResponse {
    return {
      id: result.id ?? `groq-${Date.now()}`,
      model: result.model ?? "unknown",
      content: result.choices?.[0]?.message?.content ?? "",
      provider: "groq",
    };
  }
}

export type GroqProviderErrorCode =
  | "not_configured"
  | "invalid_configuration"
  | "rate_limited"
  | "timeout"
  | "model_unavailable"
  | "temporary_failure"
  | "provider_error";

export class GroqProviderError extends Error {
  constructor(
    readonly code: GroqProviderErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GroqProviderError";
  }
}