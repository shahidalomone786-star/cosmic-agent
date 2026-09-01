export type RufloSessionStatus = "created" | "active" | "completed" | "failed" | "cancelled";
export type RufloTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type RufloMemoryKind =
  | "project_fact"
  | "coding_pattern"
  | "successful_solution"
  | "failed_solution"
  | "architecture_decision"
  | "warning"
  | "user_preference"
  | "tool_pattern"
  | "technology"
  | "architecture"
  | "success"
  | "validation_problem";

export interface RufloSession {
  id: string;
  userId: string;
  goal: string;
  status: RufloSessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface RufloTask {
  id: string;
  sessionId: string;
  title: string;
  description: string | null;
  status: RufloTaskStatus;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RufloActivity {
  id: string;
  sessionId: string;
  taskId: string | null;
  kind: string;
  message: string;
  createdAt: Date;
}

export interface CreateRufloSessionInput {
  goal: string;
}

export interface CreateRufloTaskInput {
  sessionId: string;
  title: string;
  description?: string;
  position?: number;
}

export interface CreateRufloActivityInput {
  sessionId: string;
  taskId?: string;
  kind: string;
  message: string;
}

export interface RufloMemory {
  id: string;
  userId: string;
  projectKey: string;
  kind: RufloMemoryKind;
  fact: string;
  sourceSessionId: string | null;
  sourceTaskId: string | null;
  fingerprint: string | null;
  importance: number;
  confidence: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: Date | null;
  embedding: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRufloMemoryInput {
  projectKey: string;
  kind: RufloMemoryKind;
  fact: string;
  sourceSessionId?: string;
  sourceTaskId?: string;
  importance?: number;
  confidence?: number;
  outcome?: "success" | "failure" | "neutral";
}