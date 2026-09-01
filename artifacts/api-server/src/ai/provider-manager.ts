import type { AiModel, AiProvider } from "./ai-provider";
import { GroqProvider, GroqProviderError } from "./groq-provider";
import { GeminiProvider } from "./gemini-provider";
import { GEMINI_MODELS, GROQ_MODELS, getApprovedModel } from "./model-registry";

export class ProviderManager {
  private readonly providers: readonly AiProvider[] = [
    new GroqProvider([...GROQ_MODELS]),
    new GeminiProvider([...GEMINI_MODELS]),
  ];

  getProvider(id: "groq" | "gemini" = "groq"): AiProvider {
    const provider = this.providers.find((candidate) => candidate.id === id);
    if (!provider) {
      throw new GroqProviderError("provider_error", "The requested AI provider is unavailable.");
    }
    return provider;
  }

  getProviders(): AiProvider[] {
    return [...this.providers];
  }

  getProviderForModel(modelId: string): AiProvider {
    const model = getApprovedModel(modelId);
    if (!model) throw new GroqProviderError("provider_error", "The requested AI model is unavailable.");
    return this.getProvider(model.provider);
  }

  getModels(): AiModel[] {
    return this.providers.flatMap((provider) => provider.getModels());
  }
}

export const providerManager = new ProviderManager();