export type GroqKeyHealth = "healthy" | "cooldown" | "unavailable";

export type GroqKeyStatus = {
  id: string;
  status: GroqKeyHealth;
  cooldownUntil?: number;
  lastUsedAt?: number;
  rateLimitCount: number;
};

type ManagedKey = GroqKeyStatus & {
  secret: string;
  failures: number;
};

export type GroqKeyLease = {
  id: string;
  secret: string;
};

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 15_000;

export class GroqKeyManager {
  private readonly keys: ManagedKey[];
  private nextIndex = 0;

  constructor(
    secrets: string[] = GroqKeyManager.readConfiguredSecrets(),
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
  ) {
    this.keys = secrets
      .map((secret, index) => ({ secret: secret.trim(), index }))
      .filter(({ secret }) => Boolean(secret))
      .map(({ secret, index }) => ({
        id: `groq-key-${index + 1}`,
        secret,
        status: "healthy",
        rateLimitCount: 0,
        failures: 0,
      }));
  }

  static readConfiguredSecrets(): string[] {
    const numbered = Array.from({ length: 5 }, (_, index) => process.env[`GROQ_API_KEY_${index + 1}`]?.trim() ?? "");
    const grouped = (process.env.GROQ_API_KEYS ?? "")
      .split(",")
      .map((secret) => secret.trim())
      .filter(Boolean);
    return [...numbered, ...grouped].filter(Boolean);
  }

  acquire(): GroqKeyLease | undefined {
    const now = Date.now();
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.nextIndex + offset) % this.keys.length;
      const key = this.keys[index];
      if (key.status === "unavailable") continue;
      if (key.cooldownUntil && key.cooldownUntil > now) continue;
      key.cooldownUntil = undefined;
      key.status = "healthy";
      key.lastUsedAt = now;
      this.nextIndex = (index + 1) % this.keys.length;
      return { id: key.id, secret: key.secret };
    }
    return undefined;
  }

  markSuccess(id: string): void {
    const key = this.find(id);
    if (!key) return;
    key.failures = 0;
    key.cooldownUntil = undefined;
    key.status = "healthy";
  }

  markRateLimited(id: string): void {
    const key = this.find(id);
    if (!key) return;
    key.rateLimitCount += 1;
    key.cooldownUntil = Date.now() + this.cooldownMs;
    key.status = "cooldown";
  }

  markFailure(id: string, permanent = false): void {
    const key = this.find(id);
    if (!key) return;
    key.failures += 1;
    if (permanent) {
      key.status = "unavailable";
      key.cooldownUntil = undefined;
      return;
    }
    key.cooldownUntil = Date.now() + DEFAULT_FAILURE_COOLDOWN_MS;
    key.status = "cooldown";
  }

  getStatus(): { configured: number; available: number; keys: GroqKeyStatus[] } {
    const now = Date.now();
    for (const key of this.keys) {
      if (key.status === "cooldown" && (!key.cooldownUntil || key.cooldownUntil <= now)) {
        key.status = "healthy";
        key.cooldownUntil = undefined;
      }
    }
    return {
      configured: this.keys.length,
      available: this.keys.filter((key) => key.status === "healthy" && (!key.cooldownUntil || key.cooldownUntil <= now)).length,
      keys: this.keys.map(({ id, status, cooldownUntil, lastUsedAt, rateLimitCount }) => ({ id, status, cooldownUntil, lastUsedAt, rateLimitCount })),
    };
  }

  private find(id: string): ManagedKey | undefined {
    return this.keys.find((key) => key.id === id);
  }
}

export const groqKeyManager = new GroqKeyManager();