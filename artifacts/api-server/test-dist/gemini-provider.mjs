// src/ai/groq-key-manager.ts
var DEFAULT_COOLDOWN_MS = 3e4;
var DEFAULT_FAILURE_COOLDOWN_MS = 15e3;
var GroqKeyManager = class _GroqKeyManager {
  constructor(secrets = _GroqKeyManager.readConfiguredSecrets(), cooldownMs = DEFAULT_COOLDOWN_MS, providerPrefix = "groq") {
    this.cooldownMs = cooldownMs;
    this.providerPrefix = providerPrefix;
    this.keys = secrets.map((secret, index) => ({ secret: secret.trim(), index })).filter(({ secret }) => Boolean(secret)).map(({ secret, index }) => ({
      id: `${providerPrefix}-key-${index + 1}`,
      secret,
      status: "healthy",
      rateLimitCount: 0,
      failures: 0
    }));
  }
  keys;
  nextIndex = 0;
  static readConfiguredSecrets() {
    const numbered = Array.from({ length: 5 }, (_, index) => process.env[`GROQ_API_KEY_${index + 1}`]?.trim() ?? "");
    const grouped = (process.env.GROQ_API_KEYS ?? "").split(",").map((secret) => secret.trim()).filter(Boolean);
    return [...numbered, ...grouped].filter(Boolean);
  }
  acquire() {
    const now = Date.now();
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.nextIndex + offset) % this.keys.length;
      const key = this.keys[index];
      if (key.status === "unavailable") continue;
      if (key.cooldownUntil && key.cooldownUntil > now) continue;
      key.cooldownUntil = void 0;
      key.status = "healthy";
      key.lastUsedAt = now;
      this.nextIndex = (index + 1) % this.keys.length;
      return { id: key.id, secret: key.secret };
    }
    return void 0;
  }
  markSuccess(id) {
    const key = this.find(id);
    if (!key) return;
    key.failures = 0;
    key.cooldownUntil = void 0;
    key.status = "healthy";
  }
  markRateLimited(id) {
    const key = this.find(id);
    if (!key) return;
    key.rateLimitCount += 1;
    key.cooldownUntil = Date.now() + this.cooldownMs;
    key.status = "cooldown";
  }
  markFailure(id, permanent = false) {
    const key = this.find(id);
    if (!key) return;
    key.failures += 1;
    if (permanent) {
      key.status = "unavailable";
      key.cooldownUntil = void 0;
      return;
    }
    key.cooldownUntil = Date.now() + DEFAULT_FAILURE_COOLDOWN_MS;
    key.status = "cooldown";
  }
  getStatus() {
    const now = Date.now();
    for (const key of this.keys) {
      if (key.status === "cooldown" && (!key.cooldownUntil || key.cooldownUntil <= now)) {
        key.status = "healthy";
        key.cooldownUntil = void 0;
      }
    }
    return {
      configured: this.keys.length,
      available: this.keys.filter((key) => key.status === "healthy" && (!key.cooldownUntil || key.cooldownUntil <= now)).length,
      keys: this.keys.map(({ id, status, cooldownUntil, lastUsedAt, rateLimitCount }) => ({ id, status, cooldownUntil, lastUsedAt, rateLimitCount }))
    };
  }
  find(id) {
    return this.keys.find((key) => key.id === id);
  }
};
var groqKeyManager = new GroqKeyManager();

// src/ai/groq-provider.ts
var GroqProviderError = class extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = "GroqProviderError";
  }
};

// src/ai/gemini-key-manager.ts
var GeminiKeyManager = class _GeminiKeyManager extends GroqKeyManager {
  constructor(secrets = _GeminiKeyManager.readConfiguredSecrets(), cooldownMs = 3e4) {
    super(secrets, cooldownMs, "gemini");
  }
  static readConfiguredSecrets() {
    return Array.from({ length: 5 }, (_, index) => process.env[`GEMINI_API_KEY_${index + 1}`]?.trim() ?? "").filter(Boolean);
  }
};
var geminiKeyManager = new GeminiKeyManager();

// src/ai/model-registry.ts
var GROQ_MODELS = [
  {
    id: "openai/gpt-oss-120b",
    displayName: "GPT OSS 120B",
    provider: "groq",
    capabilities: ["coding", "reasoning"],
    contextWindow: 131072,
    enabled: true,
    recommended: true
  },
  {
    id: "openai/gpt-oss-20b",
    displayName: "GPT OSS 20B",
    provider: "groq",
    capabilities: ["coding", "reasoning", "fast"],
    contextWindow: 131072,
    enabled: true,
    recommended: false
  },
  {
    id: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B",
    provider: "groq",
    capabilities: ["coding", "reasoning"],
    contextWindow: 131072,
    enabled: true,
    recommended: false
  },
  {
    id: "llama-3.1-8b-instant",
    displayName: "Llama 3.1 8B Instant",
    provider: "groq",
    capabilities: ["coding", "fast"],
    contextWindow: 131072,
    enabled: true,
    recommended: false
  }
];
var GEMINI_MODEL_ID = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
var GEMINI_MODELS = [
  {
    id: GEMINI_MODEL_ID,
    displayName: "Gemini 3.5 Flash",
    provider: "gemini",
    capabilities: ["coding", "reasoning"],
    contextWindow: 1048576,
    enabled: true,
    recommended: true
  }
];
var ALL_MODELS = [...GROQ_MODELS, ...GEMINI_MODELS];
var registry = new Map(ALL_MODELS.map((model) => [model.id, model]));

// src/lib/logger.ts
import pino from "pino";
var isProduction = process.env.NODE_ENV === "production";
var logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']"
  ],
  ...isProduction ? {} : {
    transport: {
      target: "pino-pretty",
      options: { colorize: true }
    }
  }
});

// src/ai/gemini-provider.ts
var GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
var REQUEST_TIMEOUT_MS = 45e3;
var MAX_ATTEMPTS = 2;
var GeminiProvider = class {
  constructor(models, keyManager = geminiKeyManager) {
    this.models = models;
    this.keyManager = keyManager;
  }
  id = "gemini";
  getModels() {
    return this.models.map((model) => ({ ...model, capabilities: [...model.capabilities] }));
  }
  healthCheck() {
    const status = this.keyManager.getStatus();
    return {
      available: status.available > 0,
      configured: status.configured > 0,
      message: status.configured === 0 ? "No Gemini provider keys are configured." : status.available > 0 ? "Gemini is configured server-side." : "All configured Gemini keys are temporarily unavailable."
    };
  }
  async chat(request) {
    const result = await this.requestWithFailover(request, false);
    return this.toResponse(result, request.model);
  }
  async stream(request, onToken) {
    const result = await this.requestWithFailover(request, true, onToken);
    return this.toResponse(result, request.model);
  }
  async requestWithFailover(request, stream, onToken) {
    const configured = this.keyManager.getStatus().configured;
    if (configured === 0) {
      throw new GroqProviderError("not_configured", "Gemini is not configured yet.");
    }
    let lastError;
    let emitted = false;
    for (let attempt = 0; attempt < Math.min(configured, MAX_ATTEMPTS); attempt += 1) {
      const lease = this.keyManager.acquire();
      if (!lease) break;
      try {
        const result = await this.request(lease.secret, request, stream, (token) => {
          emitted = true;
          onToken?.(token);
        });
        if (!extractText(result).trim()) {
          throw new GroqProviderError("incomplete_response", "Gemini returned an incomplete response.", true);
        }
        this.keyManager.markSuccess(lease.id);
        return result;
      } catch (error) {
        lastError = error instanceof GroqProviderError ? error : new GroqProviderError("temporary_failure", "Gemini request failed.", true);
        if (lastError.code === "rate_limited") this.keyManager.markRateLimited(lease.id);
        else if (lastError.code === "invalid_configuration") this.keyManager.markFailure(lease.id, true);
        else if (lastError.retryable) this.keyManager.markFailure(lease.id);
        if (!lastError.retryable || stream && emitted) throw lastError;
      }
    }
    throw lastError ?? new GroqProviderError("rate_limited", "Gemini is temporarily unavailable.", true);
  }
  async request(key, request, stream, onToken) {
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
        signal: controller.signal
      });
      logger.info({ provider: "gemini", model: modelId, status: response.status }, "Gemini provider response");
      if (!response.ok) throw await this.toProviderError(response);
      if (stream) return this.readStream(response, onToken ?? (() => void 0));
      return await response.json();
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
  async readStream(response, onToken) {
    if (!response.body) throw new GroqProviderError("temporary_failure", "Gemini returned no stream.", true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let responseId;
    let modelVersion;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const chunk = parseJson(line.slice(5).trim());
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
  async toProviderError(response) {
    const body = parseJson(await response.text());
    const detail = body?.error?.message ?? "";
    if (response.status === 401 || response.status === 403) {
      return new GroqProviderError("invalid_configuration", "Gemini provider configuration is invalid.");
    }
    if (response.status === 404) {
      return new GroqProviderError("model_unavailable", "The selected Gemini model is unavailable.");
    }
    if (response.status === 429) return new GroqProviderError("rate_limited", "Gemini is rate limited.", true);
    if (response.status >= 500) return new GroqProviderError("temporary_failure", "Gemini is temporarily unavailable.", true);
    if (response.status === 400 && /(context|token|prompt).*(limit|length|too large)|maximum context/i.test(detail)) {
      return new GroqProviderError("context_limit", "The request exceeded the model context limit.", true);
    }
    return new GroqProviderError("provider_error", "Gemini rejected the request.");
  }
  toResponse(result, requestedModel) {
    return {
      id: result.responseId ?? `gemini-${Date.now()}`,
      model: result.modelVersion ?? requestedModel,
      content: extractText(result),
      provider: "gemini"
    };
  }
};
function toGeminiBody(request) {
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  return {
    ...system ? { systemInstruction: { parts: [{ text: system }] } } : {},
    contents: request.messages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    })),
    generationConfig: request.temperature == null ? void 0 : { temperature: request.temperature }
  };
}
function extractText(response) {
  return response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
}
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
export {
  GeminiProvider
};
