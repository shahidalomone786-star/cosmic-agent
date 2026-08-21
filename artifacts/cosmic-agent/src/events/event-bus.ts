import type { AgentEvent, AgentEventType } from '@/agent/types';

export type AgentEventListener = (event: AgentEvent) => void;

export class AgentEventBus {
  private readonly listeners = new Set<AgentEventListener>();

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AgentEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  createEvent(
    taskId: string,
    type: AgentEventType,
    label: string,
    detail?: string,
  ): AgentEvent {
    return {
      id: `event-${Date.now()}`,
      taskId,
      type,
      label,
      detail,
      timestamp: new Date().toISOString(),
      status: 'pending',
    };
  }
}