export type AiMessageRole = "user" | "assistant" | "system";

export interface AiChatMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiModel {
  id: string;
  displayName: string;
  provider: "groq";
  capabilities: string[];
  contextWindow: number | null;
  enabled: boolean;
  recommended: boolean;
}

export interface AiChatRequest {
  model: string;
  messages: AiChatMessage[];
  temperature?: number | null;
}

export interface AiChatResponse {
  id: string;
  model: string;
  content: string;
  provider: "groq";
}

export interface ProviderHealth {
  available: boolean;
  configured: boolean;
  message: string;
}

export interface AiProvider {
  readonly id: "groq";
  chat(request: AiChatRequest): Promise<AiChatResponse>;
  stream(
    request: AiChatRequest,
    onToken: (token: string) => void,
  ): Promise<AiChatResponse>;
  getModels(): AiModel[];
  healthCheck(): ProviderHealth;
}