import type { AgentTask } from '@/agent/types';
import type { ModelInfo } from '@/providers/model-provider';
import type { RepositoryInfo } from '@/repository/repository-provider';

export interface Workspace {
  id: string;
  name: string;
  repository?: RepositoryInfo;
  currentBranch?: string;
  activeTask?: AgentTask;
  model: ModelInfo;
  createdAt: string;
  updatedAt: string;
}