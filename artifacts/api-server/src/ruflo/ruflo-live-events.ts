import { randomUUID } from "node:crypto";

export const RUFLO_LIVE_EVENT_TYPES = [
  "session_started",
  "session_state",
  "session_completed",
  "session_failed",
  "task_queued",
  "task_running",
  "task_completed",
  "task_failed",
  "task_blocked",
  "agent_started",
  "agent_completed",
  "agent_failed",
  "agent_selected",
  "test_generation",
  "documentation_analysis",
  "git_analysis",
  "browser_activity",
  "job_queued",
  "job_started",
  "job_completed",
  "job_failed",
  "job_cancelled",
  "job_retrying",
  "tool_started",
  "tool_completed",
  "tool_failed",
  "proposal_created",
  "approval_requested",
  "approval_approved",
  "approval_rejected",
  "validation_started",
  "validation_completed",
  "validation_failed",
  "recovery_started",
  "recovery_completed",
  "provider_selected",
  "provider_fallback",
  "memory_retrieved",
  "memory_learned",
  "cost_update",
  "conflict_detected",
  "lock_acquired",
  "lock_released",
] as const;

export type RufloLiveEventType = (typeof RUFLO_LIVE_EVENT_TYPES)[number];
export type RufloLiveStatus = "active" | "queued" | "running" | "completed" | "failed" | "blocked" | "waiting";

export type RufloLiveEvent = {
  id: string;
  sessionId: string;
  taskId?: string;
  type: RufloLiveEventType;
  timestamp: string;
  status: RufloLiveStatus;
  payload: Record<string, unknown>;
};

type Subscriber = (event: RufloLiveEvent) => void;
type SessionStream = {
  sequence: number;
  history: RufloLiveEvent[];
  subscribers: Set<Subscriber>;
};

const MAX_HISTORY = 120;
const MAX_SUBSCRIBERS = 24;

export class RufloLiveEventHub {
  private readonly streams = new Map<string, SessionStream>();

  publish(
    sessionId: string,
    type: RufloLiveEventType,
    status: RufloLiveStatus,
    payload: unknown = {},
    taskId?: string,
  ): RufloLiveEvent {
    const stream = this.stream(sessionId);
    const event: RufloLiveEvent = {
      id: `${stream.sequence + 1}`,
      sessionId,
      taskId,
      type,
      timestamp: new Date().toISOString(),
      status,
      payload: sanitizeRufloEventPayload(payload),
    };
    stream.sequence += 1;
    stream.history.push(event);
    if (stream.history.length > MAX_HISTORY) stream.history.splice(0, stream.history.length - MAX_HISTORY);
    for (const subscriber of [...stream.subscribers]) {
      try {
        subscriber(event);
      } catch {
        stream.subscribers.delete(subscriber);
      }
    }
    return cloneEvent(event);
  }

  subscribe(
    sessionId: string,
    lastEventId: string | undefined,
    snapshot: Record<string, unknown>,
    subscriber: Subscriber,
  ): { replay: RufloLiveEvent[]; unsubscribe: () => void } {
    const stream = this.stream(sessionId);
    const parsedLastId = parseEventId(lastEventId);
    if (stream.subscribers.size >= MAX_SUBSCRIBERS) {
      throw new Error("The Ruflo live event connection limit was reached.");
    }
    const oldestId = stream.history[0] ? Number(stream.history[0].id) : stream.sequence + 1;
    const replay = parsedLastId === undefined
      ? []
      : parsedLastId >= oldestId - 1
        ? stream.history.filter((event) => Number(event.id) > parsedLastId).map(cloneEvent)
        : [];
    const initial = parsedLastId === undefined || parsedLastId < oldestId - 1
      ? [this.publishSnapshot(stream, sessionId, snapshot)]
      : replay;
    stream.subscribers.add(subscriber);
    let connected = true;
    return {
      replay: initial,
      unsubscribe: () => {
        if (!connected) return;
        connected = false;
        stream.subscribers.delete(subscriber);
        this.prune(sessionId);
      },
    };
  }

  historySize(sessionId: string): number {
    return this.streams.get(sessionId)?.history.length ?? 0;
  }

  subscriberCount(sessionId: string): number {
    return this.streams.get(sessionId)?.subscribers.size ?? 0;
  }

  clear(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (!stream || stream.subscribers.size) return;
    this.streams.delete(sessionId);
  }

  private stream(sessionId: string): SessionStream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { sequence: 0, history: [], subscribers: new Set() };
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  private publishSnapshot(stream: SessionStream, sessionId: string, snapshot: Record<string, unknown>): RufloLiveEvent {
    const event: RufloLiveEvent = {
      id: `${stream.sequence + 1}`,
      sessionId,
      type: "session_state",
      timestamp: new Date().toISOString(),
      status: "running",
      payload: sanitizeRufloEventPayload(snapshot),
    };
    stream.sequence += 1;
    stream.history.push(event);
    if (stream.history.length > MAX_HISTORY) stream.history.splice(0, stream.history.length - MAX_HISTORY);
    return cloneEvent(event);
  }

  private prune(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (stream && !stream.subscribers.size && !stream.history.length) this.streams.delete(sessionId);
  }
}

export const rufloLiveEventHub = new RufloLiveEventHub();

export function canReadRufloSession(requestUserId: string, ownerId: string, requestedProjectId?: string, sessionProjectId?: string): boolean {
  return Boolean(requestUserId && ownerId && requestUserId === ownerId && (!requestedProjectId || requestedProjectId === sessionProjectId));
}

export function sanitizeRufloEventPayload(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return { value: "[truncated]" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value: sanitizeValue(value, depth) };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
    if (/(api[_-]?key|token|secret|password|cookie|authorization|private[_-]?key|credential|session[_-]?cookie)/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = sanitizeValue(item, depth + 1);
    }
  }
  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]").replace(/(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, (match) => `${match.split(/[:=]/)[0]}=[redacted]`).slice(0, 1_000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => sanitizeValue(item, depth + 1));
  return sanitizeRufloEventPayload(value, depth);
}

function parseEventId(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,12}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function cloneEvent(event: RufloLiveEvent): RufloLiveEvent {
  return {
    ...event,
    payload: sanitizeRufloEventPayload(event.payload),
  };
}

export function createRufloEventId(): string {
  return randomUUID();
}