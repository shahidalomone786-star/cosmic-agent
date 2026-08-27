import { GroqKeyManager } from "./groq-key-manager";

export class GeminiKeyManager extends GroqKeyManager {
  constructor(
    secrets: string[] = GeminiKeyManager.readConfiguredSecrets(),
    cooldownMs = 30_000,
  ) {
    super(secrets, cooldownMs, "gemini");
  }

  static readConfiguredSecrets(): string[] {
    return Array.from({ length: 12 }, (_, index) => process.env[`GEMINI_API_KEY_${index + 1}`]?.trim() ?? "")
      .filter(Boolean);
  }
}

export const geminiKeyManager = new GeminiKeyManager();