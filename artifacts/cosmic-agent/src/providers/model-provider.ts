import type { AgentMessage } from '@/agent/types';

export type ModelProviderKind =
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'google-compatible'
  | 'local';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ModelProviderKind;
  contextWindow?: number;
  supportsStreaming: boolean;
}

export interface ModelRequest {
  messages: AgentMessage[];
  systemPrompt?: string;
  temperature?: number;
}

export interface ModelResponse {
  message: AgentMessage;
  model: ModelInfo;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  sendMessage(request: ModelRequest): Promise<ModelResponse>;
  streamMessage(
    request: ModelRequest,
    onToken: (token: string) => void,
  ): Promise<ModelResponse>;
  getModelInfo(): ModelInfo;
}