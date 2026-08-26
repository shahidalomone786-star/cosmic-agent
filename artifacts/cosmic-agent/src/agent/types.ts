export type AgentRole = 'user' | 'assistant' | 'system';

export type AgentMessageStatus = 'complete' | 'streaming' | 'error';

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: string;
  status: AgentMessageStatus;
  codeBlocks?: Array<{
    language?: string;
    code: string;
  }>;
}

export type AgentEventType =
  | 'task_started'
  | 'planning'
  | 'tool_started'
  | 'tool_finished'
  | 'file_read'
  | 'file_changed'
  | 'command_started'
  | 'command_finished'
  | 'test_started'
  | 'test_finished'
  | 'task_completed'
  | 'task_failed';

export interface AgentEvent {
  id: string;
  taskId: string;
  type: AgentEventType;
  label: string;
  detail?: string;
  timestamp: string;
  status: 'pending' | 'active' | 'complete' | 'failed';
  requiresApproval?: boolean;
}

export interface AgentPlan {
  id: string;
  taskId: string;
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'active' | 'complete' | 'blocked';
  }>;
  createdAt: string;
}

export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  status: 'idle' | 'active' | 'completed' | 'failed';
  messages: AgentMessage[];
  events: AgentEvent[];
  plan?: AgentPlan;
  createdAt: string;
  updatedAt: string;
}