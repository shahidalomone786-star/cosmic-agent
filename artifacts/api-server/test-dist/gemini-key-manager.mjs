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
      status: "available",
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
      key.status = "available";
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
    key.status = "available";
  }
  markRateLimited(id) {
    const key = this.find(id);
    if (!key) return;
    key.rateLimitCount += 1;
    key.cooldownUntil = Date.now() + this.cooldownMs;
    key.status = "rate_limited";
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
    key.status = "temporarily_failed";
  }
  getStatus() {
    const now = Date.now();
    for (const key of this.keys) {
      if ((key.status === "rate_limited" || key.status === "temporarily_failed") && (!key.cooldownUntil || key.cooldownUntil <= now)) {
        key.status = "available";
        key.cooldownUntil = void 0;
      }
    }
    return {
      configured: this.keys.length,
      available: this.keys.filter((key) => key.status === "available" && (!key.cooldownUntil || key.cooldownUntil <= now)).length,
      keys: this.keys.map(({ id, status, cooldownUntil, lastUsedAt, rateLimitCount }) => ({ id, status, cooldownUntil, lastUsedAt, rateLimitCount }))
    };
  }
  find(id) {
    return this.keys.find((key) => key.id === id);
  }
};
var groqKeyManager = new GroqKeyManager();

// src/ai/gemini-key-manager.ts
var GeminiKeyManager = class _GeminiKeyManager extends GroqKeyManager {
  constructor(secrets = _GeminiKeyManager.readConfiguredSecrets(), cooldownMs = 3e4) {
    super(secrets, cooldownMs, "gemini");
  }
  static readConfiguredSecrets() {
    return Array.from({ length: 12 }, (_, index) => process.env[`GEMINI_API_KEY_${index + 1}`]?.trim() ?? "").filter(Boolean);
  }
};
var geminiKeyManager = new GeminiKeyManager();
export {
  GeminiKeyManager,
  geminiKeyManager
};
