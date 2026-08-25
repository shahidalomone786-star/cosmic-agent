import type { AiModel } from "./ai-provider";

// Keep model IDs in one place. These are approved IDs from Groq's OpenAI-compatible
// model catalog; update this list as Groq changes availability.
export const GROQ_MODELS: readonly AiModel[] = [
  {
    id: "openai/gpt-oss-120b",
    displayName: "GPT OSS 120B",
    provider: "groq",
    capabilities: ["coding", "reasoning"],
    contextWindow: 131072,
    enabled: true,
    recommended: true,
  },
  {
    id: "openai/gpt-oss-20b",
    displayName: "GPT OSS 20B",
    provider: "groq",
    capabilities: ["coding", "reasoning", "fast"],
    contextWindow: 131072,
    enabled: true,
    recommended: false,
  },
  {
    id: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B",
    provider: "groq",
    capabilities: ["coding", "reasoning"],
    contextWindow: 131072,
    enabled: true,
    recommended: false,
  },
  {
    id: "llama-3.1-8b-instant",
    displayName: "Llama 3.1 8B Instant",
    provider: "groq",
    capabilities: ["coding", "fast"],
    contextWindow: 131072,
    enabled: true,
    recommended: false,
  },
];

export const GEMINI_MODEL_ID = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";

export const GEMINI_MODELS: readonly AiModel[] = [
  {
    id: GEMINI_MODEL_ID,
    displayName: "Gemini 3.5 Flash",
    provider: "gemini",
    capabilities: ["coding", "reasoning"],
    contextWindow: 1_048_576,
    enabled: true,
    recommended: true,
  },
];

export const ALL_MODELS: readonly AiModel[] = [...GROQ_MODELS, ...GEMINI_MODELS];
const registry = new Map(ALL_MODELS.map((model) => [model.id, model]));

export function listEnabledModels(): AiModel[] {
  return ALL_MODELS.filter((model) => model.enabled).map((model) => ({
    ...model,
    capabilities: [...model.capabilities],
  }));
}

export function getApprovedModel(modelId: string): AiModel | undefined {
  const model = registry.get(modelId);
  return model?.enabled ? model : undefined;
}