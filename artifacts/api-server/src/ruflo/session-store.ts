import type {
  CreateRufloActivityInput,
  CreateRufloSessionInput,
  CreateRufloTaskInput,
  RufloActivity,
  RufloSession,
  RufloTask,
} from "./types";

export interface RufloSessionStore {
  createSession(userId: string, input: CreateRufloSessionInput): Promise<RufloSession>;
  updateSessionStatus(userId: string, sessionId: string, status: RufloSession["status"]): Promise<RufloSession>;
  getSession(userId: string, sessionId: string): Promise<RufloSession | undefined>;
  listSessions(userId: string): Promise<RufloSession[]>;
  createTask(userId: string, input: CreateRufloTaskInput): Promise<RufloTask>;
  listTasks(userId: string, sessionId: string): Promise<RufloTask[]>;
  createActivity(userId: string, input: CreateRufloActivityInput): Promise<RufloActivity>;
  listActivities(userId: string, sessionId: string): Promise<RufloActivity[]>;
}