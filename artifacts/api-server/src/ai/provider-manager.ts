import type { AiProvider } from "./ai-provider";
import { GroqProvider, GroqProviderError } from "./groq-provider";
import { GROQ_MODELS } from "./model-registry";

export class ProviderManager {
  private readonly providers: readonly AiProvider[] = [
    new GroqProvider([...GROQ_MODELS]),
  ];

  getProvider(id = "groq"): AiProvider {
    const provider = this.providers.find((candidate) => candidate.id === id);
    if (!provider) {
      throw new GroqProviderError("provider_error", "The requested AI provider is unavailable.");
    }
    return provider;
  }
}

export const providerManager = new ProviderManager();