import type {
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from './model-provider';
import type { AgentMessage } from '@/agent/types';

const MOCK_MODEL: ModelInfo = {
  id: 'cosmic-foundation-preview',
  name: 'Foundation preview',
  provider: 'openai-compatible',
  contextWindow: 32_000,
  supportsStreaming: true,
};

export class MockModelProvider implements ModelProvider {
  readonly kind = MOCK_MODEL.provider;

  getModelInfo(): ModelInfo {
    return MOCK_MODEL;
  }

  async sendMessage(request: ModelRequest): Promise<ModelResponse> {
    return {
      model: MOCK_MODEL,
      message: this.createResponse(request),
    };
  }

  async streamMessage(
    request: ModelRequest,
    onToken: (token: string) => void,
  ): Promise<ModelResponse> {
    const response = this.createResponse(request);
    response.content.split(' ').forEach((token, index, tokens) => {
      onToken(`${token}${index === tokens.length - 1 ? '' : ' '}`);
    });
    return { model: MOCK_MODEL, message: response };
  }

  private createResponse(request: ModelRequest): AgentMessage {
    const latestUserMessage =
      [...request.messages].reverse().find((message) => message.role === 'user')
        ?.content ?? 'your request';

    return {
      id: `mock-${Date.now()}`,
      role: 'assistant',
      content: `I’ve captured “${latestUserMessage}”. The foundation is ready for a future planning pass. No repository or command operations were performed.`,
      createdAt: new Date().toISOString(),
      status: 'complete',
    };
  }
}