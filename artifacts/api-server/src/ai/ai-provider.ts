export type AiMessageRole = "user" | "assistant" | "system";
export type AiRequestRole = "manager" | "frontend" | "backend" | "reviewer" | "validator";

export interface AiChatMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiModel {
  id: string;
  displayName: string;
  provider: "groq" | "gemini";
  capabilities: string[];
  contextWindow: number | null;
  capabilityClasses?: Array<"light" | "medium" | "heavy">;
  strength?: number;
  costTier?: "low" | "medium" | "high";
  enabled: boolean;
  recommended: boolean;
}

export interface AiChatRequest {
  model: string;
  messages: AiChatMessage[];
  temperature?: number | null;
  role?: AiRequestRole;
  maxOutputTokens?: number | null;
}

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  exact: boolean;
};

export interface AiChatResponse {
  id: string;
  model: string;
  content: string;
  provider: "groq" | "gemini";
  usage?: AiUsage;
}

export interface ProviderHealth {
  available: boolean;
  configured: boolean;
  message: string;
}

export interface AiProvider {
  readonly id: "groq" | "gemini";
  chat(request: AiChatRequest): Promise<AiChatResponse>;
  stream(
    request: AiChatRequest,
    onToken: (token: string) => void,
  ): Promise<AiChatResponse>;
  getModels(): AiModel[];
  healthCheck(): ProviderHealth;
}