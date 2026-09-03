import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { RUFLO_PHASE9_AGENT_CAPABILITIES } from "./ruflo-phase9-catalog";

export type RufloSwarmTopology = "hierarchical" | "mesh";
export type RufloSwarmStatus = "created" | "running" | "completed" | "failed" | "cancelled";
export type RufloAgentStatus = "active" | "idle" | "busy" | "expired" | "terminated" | "cancelled";
export type RufloAgentRole = "leader" | "worker" | "peer";
export type RufloMessageStatus = "queued" | "delivered" | "acknowledged";
export type RufloSwarmTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type RufloConsensusStatus = "open" | "reached" | "rejected" | "conflict";

export type RufloSwarm = {
  id: string;
  userId: string;
  sessionId: string;
  projectId: string;
  topology: RufloSwarmTopology;
  status: RufloSwarmStatus;
  leaderAgentId?: string;
  limits: { maxAgents: number; maxTasks: number; leaseMs: number };
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type RufloAgent = {
  id: string;
  swarmId: string;
  userId: string;
  name: string;
  type: string;
  role: RufloAgentRole;
  parentId?: string;
  capabilities: string[];
  metadata: Record<string, unknown>;
  credentialNonce: string;
  status: RufloAgentStatus;
  lastHeartbeatAt?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RufloSwarmMessage = {
  id: string;
  swarmId: string;
  fromAgentId: string;
  toAgentId: string;
  type: string;
  payload: Record<string, unknown>;
  status: RufloMessageStatus;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
};

export type RufloBlackboardEntry = {
  id: string;
  swarmId: string;
  namespace: string;
  key: string;
  value: unknown;
  version: number;
  updatedByAgentId: string;
  createdAt: string;
  updatedAt: string;
};

export type RufloSwarmSubscription = {
  id: string;
  swarmId: string;
  agentId: string;
  eventType: string;
  createdAt: string;
};

export type RufloSwarmEvent = {
  id: string;
  swarmId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type RufloSwarmTask = {
  id: string;
  swarmId: string;
  sessionId: string;
  title: string;
  description?: string;
  status: RufloSwarmTaskStatus;
  assignedAgentId?: string;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
  leaseOwnerAgentId?: string;
  leaseExpiresAt?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type RufloConsensusVote = { agentId: string; value: unknown; submittedAt: string };
export type RufloConsensus = {
  id: string;
  swarmId: string;
  type: string;
  payload: Record<string, unknown>;
  strategy: "majority" | "quorum";
  voterAgentIds: string[];
  votes: RufloConsensusVote[];
  status: RufloConsensusStatus;
  decision?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type RufloSwarmRepository = {
  createSwarm(swarm: RufloSwarm): Promise<RufloSwarm>;
  getSwarm(userId: string, swarmId: string): Promise<RufloSwarm | undefined>;
  updateSwarm(swarm: RufloSwarm): Promise<RufloSwarm>;
  listAgents(swarmId: string): Promise<RufloAgent[]>;
  getAgent(swarmId: string, agentId: string): Promise<RufloAgent | undefined>;
  createAgent(agent: RufloAgent): Promise<RufloAgent>;
  updateAgent(agent: RufloAgent): Promise<RufloAgent>;
  createMessage(message: RufloSwarmMessage): Promise<RufloSwarmMessage>;
  listMailbox(swarmId: string, agentId: string, limit: number): Promise<RufloSwarmMessage[]>;
  getMessage(swarmId: string, messageId: string): Promise<RufloSwarmMessage | undefined>;
  updateMessage(message: RufloSwarmMessage): Promise<RufloSwarmMessage>;
  getBlackboard(swarmId: string, namespace: string, key: string): Promise<RufloBlackboardEntry | undefined>;
  listBlackboard(swarmId: string, namespace?: string): Promise<RufloBlackboardEntry[]>;
  upsertBlackboard(entry: RufloBlackboardEntry, expectedVersion?: number): Promise<RufloBlackboardEntry>;
  createSubscription(subscription: RufloSwarmSubscription): Promise<RufloSwarmSubscription>;
  listSubscriptions(swarmId: string, agentId: string): Promise<RufloSwarmSubscription[]>;
  createEvent(event: RufloSwarmEvent): Promise<RufloSwarmEvent>;
  listEvents(swarmId: string, afterSequence: number, limit: number): Promise<RufloSwarmEvent[]>;
  createTask(task: RufloSwarmTask): Promise<RufloSwarmTask>;
  getTask(swarmId: string, taskId: string): Promise<RufloSwarmTask | undefined>;
  listTasks(swarmId: string): Promise<RufloSwarmTask[]>;
  updateTask(task: RufloSwarmTask): Promise<RufloSwarmTask>;
  createConsensus(consensus: RufloConsensus): Promise<RufloConsensus>;
  getConsensus(swarmId: string, consensusId: string): Promise<RufloConsensus | undefined>;
  updateConsensus(consensus: RufloConsensus): Promise<RufloConsensus>;
  recoverExpired(now: string): Promise<{ agents: number; tasks: number }>;
};

export type RufloSwarmLimits = RufloSwarm["limits"];

const MAX_AGENTS = 5;
const MAX_TASKS = 32;
const MAX_MESSAGE_BYTES = 16_000;
const MAX_CONTEXT_BYTES = 24_000;
const LEASE_MS = 30_000;

export const RUFLO_AGENT_CAPABILITIES: Record<string, string[]> = {
  coordinator: ["agent:spawn", "context:read", "context:write", "message:send", "message:receive", "consensus:vote"],
  planner: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"],
  coder: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"],
  reviewer: ["context:read", "message:send", "message:receive", "consensus:vote"],
  validator: ["context:read", "message:send", "message:receive", "consensus:vote"],
  tester: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"],
  ...RUFLO_PHASE9_AGENT_CAPABILITIES,
};

export class RufloSwarmError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RufloSwarmError";
  }
}

export class RufloSwarmService {
  constructor(
    private readonly repository: RufloSwarmRepository,
    private readonly credentialSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!credentialSecret || credentialSecret.length < 16) {
      throw new RufloSwarmError("configuration", "Ruflo swarm credentials require a configured signing secret.");
    }
  }

  async createSwarm(userId: string, input: { sessionId: string; projectId: string; topology?: RufloSwarmTopology; maxAgents?: number }): Promise<{ swarm: RufloSwarm; leader: RufloAgent; credential: string }> {
    const timestamp = this.now().toISOString();
    const swarm: RufloSwarm = {
      id: randomUUID(),
      userId,
      sessionId: requiredId(input.sessionId, "sessionId"),
      projectId: boundedId(input.projectId, "default"),
      topology: input.topology === "mesh" ? "mesh" : "hierarchical",
      status: "running",
      limits: { maxAgents: clamp(input.maxAgents, 5, 1, MAX_AGENTS), maxTasks: MAX_TASKS, leaseMs: LEASE_MS },
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.createSwarm(swarm);
    const leader = await this.createAgentRecord(swarm, {
      name: "manager",
      type: "coordinator",
      role: "leader",
      capabilities: RUFLO_AGENT_CAPABILITIES.coordinator,
    });
    swarm.leaderAgentId = leader.id;
    await this.repository.updateSwarm(swarm);
    await this.emit(swarm, "swarm.started", { topology: swarm.topology, leaderAgentId: leader.id });
    return { swarm, leader, credential: this.issueCredential(swarm, leader) };
  }

  async registerAgent(userId: string, swarmId: string, auth: AgentAuth, input: { name: string; type?: string; role?: RufloAgentRole; parentId?: string; capabilities?: string[] }): Promise<{ agent: RufloAgent; credential: string }> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const caller = await this.authenticateAgent(userId, swarm, auth);
    requireCapability(caller, "agent:spawn");
    const agents = await this.repository.listAgents(swarm.id);
    if (agents.length >= swarm.limits.maxAgents) throw new RufloSwarmError("agent_limit", "The swarm agent limit was reached.");
    const role = input.role === "peer" ? "peer" : "worker";
    const parentId = swarm.topology === "hierarchical" ? (input.parentId ?? swarm.leaderAgentId) : input.parentId;
    if (parentId && !agents.some((agent) => agent.id === parentId)) throw new RufloSwarmError("invalid_parent", "The requested parent agent is not in this swarm.");
    const type = boundedId(input.type ?? "coder", "coder");
    const allowed = new Set(RUFLO_AGENT_CAPABILITIES[type] ?? RUFLO_AGENT_CAPABILITIES.coder);
    const capabilities = (input.capabilities?.length ? input.capabilities : [...allowed]).filter((capability) => allowed.has(capability)).slice(0, 12);
    const agent = await this.createAgentRecord(swarm, { ...input, name: input.name, type, role, parentId, capabilities });
    await this.emit(swarm, "agent.registered", { agentId: agent.id, type: agent.type, role: agent.role });
    return { agent, credential: this.issueCredential(swarm, agent) };
  }

  async listAgents(userId: string, swarmId: string): Promise<RufloAgent[]> {
    await this.requireSwarm(userId, swarmId);
    return this.repository.listAgents(swarmId);
  }

  async sendMessage(userId: string, swarmId: string, auth: AgentAuth, input: { toAgentId: string; type: string; payload: Record<string, unknown> }): Promise<RufloSwarmMessage> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const sender = await this.authenticateAgent(userId, swarm, auth);
    requireCapability(sender, "message:send");
    const recipient = await this.repository.getAgent(swarmId, requiredId(input.toAgentId, "toAgentId"));
    if (!recipient || recipient.status === "terminated" || recipient.status === "cancelled") throw new RufloSwarmError("recipient_not_found", "The recipient agent is not active in this swarm.");
    if (swarm.topology === "hierarchical" && sender.role === "worker" && recipient.role === "worker" && sender.id !== recipient.id) {
      throw new RufloSwarmError("topology", "Hierarchical swarms route worker collaboration through the leader.");
    }
    const type = boundedId(input.type, "message");
    const payload = boundRecord(input.payload, MAX_MESSAGE_BYTES);
    const timestamp = this.now().toISOString();
    const message = await this.repository.createMessage({
      id: randomUUID(), swarmId, fromAgentId: sender.id, toAgentId: recipient.id, type, payload, status: "delivered", deliveredAt: timestamp, createdAt: timestamp,
    });
    await this.emit(swarm, "agent.message", { messageId: message.id, fromAgentId: sender.id, toAgentId: recipient.id, type });
    return message;
  }

  async readMailbox(userId: string, swarmId: string, auth: AgentAuth, limit = 24): Promise<RufloSwarmMessage[]> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    requireCapability(agent, "message:receive");
    return this.repository.listMailbox(swarmId, agent.id, clamp(limit, 24, 1, 50));
  }

  async acknowledgeMessage(userId: string, swarmId: string, auth: AgentAuth, messageId: string): Promise<RufloSwarmMessage> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    const message = await this.repository.getMessage(swarmId, requiredId(messageId, "messageId"));
    if (!message || message.toAgentId !== agent.id) throw new RufloSwarmError("message_not_found", "The message does not belong to this agent.");
    message.status = "acknowledged";
    message.acknowledgedAt = this.now().toISOString();
    return this.repository.updateMessage(message);
  }

  async readContext(userId: string, swarmId: string, auth: AgentAuth, namespace?: string): Promise<RufloBlackboardEntry[]> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    requireCapability(agent, "context:read");
    return this.repository.listBlackboard(swarmId, namespace ? boundedId(namespace, "default") : undefined);
  }

  async writeContext(userId: string, swarmId: string, auth: AgentAuth, input: { namespace: string; key: string; value: unknown; expectedVersion?: number }): Promise<RufloBlackboardEntry> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    requireCapability(agent, "context:write");
    const namespace = boundedId(input.namespace, "default");
    const key = boundedId(input.key, "value");
    const value = boundJson(input.value, MAX_CONTEXT_BYTES);
    const current = await this.repository.getBlackboard(swarmId, namespace, key);
    if (current && input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new RufloSwarmError("context_conflict", `Context ${namespace}/${key} changed at version ${current.version}; reload before writing.`);
    }
    const timestamp = this.now().toISOString();
    const entry = await this.repository.upsertBlackboard({
      id: current?.id ?? randomUUID(), swarmId, namespace, key, value, version: (current?.version ?? 0) + 1,
      updatedByAgentId: agent.id, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp,
    }, current?.version ?? 0);
    await this.emit(swarm, "context.updated", { namespace, key, version: entry.version, updatedByAgentId: agent.id });
    return entry;
  }

  async subscribe(userId: string, swarmId: string, auth: AgentAuth, eventType: string): Promise<RufloSwarmSubscription> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    requireCapability(agent, "message:receive");
    if (!/^[a-z0-9.*:_-]{1,80}$/i.test(eventType)) throw new RufloSwarmError("invalid_event", "Event subscriptions must use a bounded event name.");
    return this.repository.createSubscription({ id: randomUUID(), swarmId, agentId: agent.id, eventType, createdAt: this.now().toISOString() });
  }

  async listEvents(userId: string, swarmId: string, auth: AgentAuth, afterSequence = 0): Promise<RufloSwarmEvent[]> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    const subscriptions = await this.repository.listSubscriptions(swarmId, agent.id);
    if (!subscriptions.length) throw new RufloSwarmError("subscription_required", "Subscribe to swarm events before reading the event stream.");
    const events = await this.repository.listEvents(swarmId, Math.max(0, Math.floor(afterSequence)), 120);
    return events.filter((event) => subscriptions.some((subscription) => subscription.eventType === "*" || subscription.eventType === event.type || (subscription.eventType.endsWith(".*") && event.type.startsWith(subscription.eventType.slice(0, -1))))).slice(0, 120);
  }

  async heartbeat(userId: string, swarmId: string, auth: AgentAuth): Promise<RufloAgent> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth, false);
    if (agent.status === "terminated" || agent.status === "cancelled") throw new RufloSwarmError("agent_inactive", "This agent cannot send a heartbeat.");
    const now = this.now();
    agent.status = "active";
    agent.lastHeartbeatAt = now.toISOString();
    agent.leaseExpiresAt = new Date(now.getTime() + swarm.limits.leaseMs).toISOString();
    return this.repository.updateAgent(agent);
  }

  async acquireTaskLease(userId: string, swarmId: string, auth: AgentAuth, taskId: string): Promise<RufloSwarmTask> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    const task = await this.repository.getTask(swarmId, requiredId(taskId, "taskId"));
    if (!task) throw new RufloSwarmError("task_not_found", "The swarm task was not found.");
    const now = this.now();
    if (task.leaseExpiresAt && new Date(task.leaseExpiresAt) > now && task.leaseOwnerAgentId !== agent.id) throw new RufloSwarmError("lease_taken", "The task is leased by another active agent.");
    task.assignedAgentId = agent.id;
    task.leaseOwnerAgentId = agent.id;
    task.leaseExpiresAt = new Date(now.getTime() + swarm.limits.leaseMs).toISOString();
    task.status = "in_progress";
    task.attempts += 1;
    agent.status = "busy";
    await this.repository.updateAgent(agent);
    const updated = await this.repository.updateTask(task);
    await this.emit(swarm, "task.leased", { taskId: task.id, agentId: agent.id });
    return updated;
  }

  async completeTask(userId: string, swarmId: string, auth: AgentAuth, taskId: string, input: { result?: unknown; error?: string }): Promise<RufloSwarmTask> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    const task = await this.repository.getTask(swarmId, requiredId(taskId, "taskId"));
    if (!task || task.leaseOwnerAgentId !== agent.id) throw new RufloSwarmError("lease_owner", "Only the current task lease owner can complete this task.");
    task.status = input.error ? "failed" : "completed";
    task.error = input.error?.slice(0, 1_000);
    task.result = input.error ? undefined : boundJson(input.result, MAX_CONTEXT_BYTES);
    task.leaseExpiresAt = undefined;
    task.leaseOwnerAgentId = undefined;
    agent.status = "idle";
    await this.repository.updateAgent(agent);
    return this.repository.updateTask(task);
  }

  async createTask(userId: string, swarmId: string, input: { title: string; description?: string; payload?: Record<string, unknown> }): Promise<RufloSwarmTask> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const tasks = await this.repository.listTasks(swarmId);
    if (tasks.length >= swarm.limits.maxTasks) throw new RufloSwarmError("task_limit", "The swarm task limit was reached.");
    const timestamp = this.now().toISOString();
    return this.repository.createTask({
      id: randomUUID(), swarmId, sessionId: swarm.sessionId, title: boundedText(input.title, 240), description: input.description?.slice(0, 2_000),
      status: "pending", payload: boundRecord(input.payload ?? {}, MAX_CONTEXT_BYTES), attempts: 0, createdAt: timestamp, updatedAt: timestamp,
    });
  }

  async listTasks(userId: string, swarmId: string): Promise<RufloSwarmTask[]> {
    await this.requireSwarm(userId, swarmId);
    return this.repository.listTasks(swarmId);
  }

  async cancelSwarm(userId: string, swarmId: string): Promise<RufloSwarm> {
    const swarm = await this.requireSwarm(userId, swarmId);
    swarm.status = "cancelled";
    swarm.revision += 1;
    await this.repository.updateSwarm(swarm);
    await this.emit(swarm, "swarm.cancelled", { reason: "user_requested" });
    return swarm;
  }

  async createConsensus(userId: string, swarmId: string, auth: AgentAuth, input: { type: string; payload: Record<string, unknown>; voterAgentIds?: string[]; strategy?: "majority" | "quorum" }): Promise<RufloConsensus> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const leader = await this.authenticateAgent(userId, swarm, auth);
    requireCapability(leader, "consensus:vote");
    if (leader.role !== "leader") throw new RufloSwarmError("leader_required", "Only the swarm leader can open a consensus round.");
    const agents = await this.repository.listAgents(swarmId);
    const voters = [...new Set(input.voterAgentIds ?? agents.filter((agent) => agent.status === "active").map((agent) => agent.id))].slice(0, MAX_AGENTS);
    if (!voters.length || voters.some((id) => !agents.some((agent) => agent.id === id))) throw new RufloSwarmError("invalid_voters", "Consensus voters must be agents in this swarm.");
    const timestamp = this.now().toISOString();
    const consensus = await this.repository.createConsensus({
      id: randomUUID(), swarmId, type: boundedId(input.type, "decision"), payload: boundRecord(input.payload, MAX_CONTEXT_BYTES),
      strategy: input.strategy === "quorum" ? "quorum" : "majority", voterAgentIds: voters, votes: [], status: "open", createdAt: timestamp, updatedAt: timestamp,
    });
    await this.emit(swarm, "consensus.opened", { consensusId: consensus.id, voterCount: voters.length });
    return consensus;
  }

  async vote(userId: string, swarmId: string, auth: AgentAuth, consensusId: string, value: unknown): Promise<RufloConsensus> {
    const swarm = await this.requireSwarm(userId, swarmId);
    const agent = await this.authenticateAgent(userId, swarm, auth);
    requireCapability(agent, "consensus:vote");
    const consensus = await this.repository.getConsensus(swarmId, requiredId(consensusId, "consensusId"));
    if (!consensus || consensus.status !== "open") throw new RufloSwarmError("consensus_closed", "The consensus round is not open.");
    if (!consensus.voterAgentIds.includes(agent.id)) throw new RufloSwarmError("not_voter", "This agent is not an eligible voter.");
    if (consensus.votes.some((vote) => vote.agentId === agent.id)) throw new RufloSwarmError("duplicate_vote", "An agent may vote once per consensus round.");
    consensus.votes.push({ agentId: agent.id, value: boundJson(value, 4_000), submittedAt: this.now().toISOString() });
    aggregateConsensus(consensus);
    consensus.updatedAt = this.now().toISOString();
    const updated = await this.repository.updateConsensus(consensus);
    await this.emit(swarm, "consensus.vote", { consensusId: consensus.id, agentId: agent.id, status: updated.status });
    return updated;
  }

  async getState(userId: string, swarmId: string): Promise<{ swarm: RufloSwarm; agents: RufloAgent[]; tasks: RufloSwarmTask[]; blackboard: RufloBlackboardEntry[]; events: RufloSwarmEvent[] }> {
    await this.repository.recoverExpired(this.now().toISOString());
    const swarm = await this.requireSwarm(userId, swarmId);
    return {
      swarm,
      agents: await this.repository.listAgents(swarmId),
      tasks: await this.repository.listTasks(swarmId),
      blackboard: await this.repository.listBlackboard(swarmId),
      events: await this.repository.listEvents(swarmId, 0, 120),
    };
  }

  async recover(): Promise<{ agents: number; tasks: number }> {
    return this.repository.recoverExpired(this.now().toISOString());
  }

  authenticateAgentCredential(userId: string, swarm: RufloSwarm, auth: AgentAuth, agent: RufloAgent): boolean {
    if (auth.agentId !== agent.id || agent.userId !== userId) return false;
    const expected = Buffer.from(this.issueCredential(swarm, agent));
    const received = Buffer.from(auth.credential);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private async authenticateAgent(userId: string, swarm: RufloSwarm, auth: AgentAuth, requireLease = true): Promise<RufloAgent> {
    const agent = await this.repository.getAgent(swarm.id, requiredId(auth.agentId, "agentId"));
    if (!agent || !this.authenticateAgentCredential(userId, swarm, auth, agent)) throw new RufloSwarmError("agent_unauthorized", "The agent credential is invalid for this swarm.");
    if (agent.status === "terminated" || agent.status === "cancelled") throw new RufloSwarmError("agent_inactive", "This agent is no longer active.");
    if (requireLease && agent.leaseExpiresAt && new Date(agent.leaseExpiresAt) <= this.now()) throw new RufloSwarmError("lease_expired", "The agent lease expired; send a heartbeat before continuing.");
    return agent;
  }

  private async requireSwarm(userId: string, swarmId: string): Promise<RufloSwarm> {
    const swarm = await this.repository.getSwarm(userId, requiredId(swarmId, "swarmId"));
    if (!swarm) throw new RufloSwarmError("not_found", "The Ruflo swarm was not found.");
    if (swarm.status === "cancelled") throw new RufloSwarmError("swarm_cancelled", "The Ruflo swarm has been cancelled.");
    return swarm;
  }

  private async createAgentRecord(swarm: RufloSwarm, input: { name: string; type: string; role: RufloAgentRole; parentId?: string; capabilities: string[] }): Promise<RufloAgent> {
    const timestamp = this.now().toISOString();
    const agent: RufloAgent = {
      id: randomUUID(), swarmId: swarm.id, userId: swarm.userId, name: boundedText(input.name, 100), type: input.type, role: input.role,
      parentId: input.parentId, capabilities: [...new Set(input.capabilities)].slice(0, 12), metadata: {}, credentialNonce: randomUUID(),
      status: "active", lastHeartbeatAt: timestamp, leaseExpiresAt: new Date(this.now().getTime() + swarm.limits.leaseMs).toISOString(), createdAt: timestamp, updatedAt: timestamp,
    };
    return this.repository.createAgent(agent);
  }

  private issueCredential(swarm: RufloSwarm, agent: RufloAgent): string {
    const body = Buffer.from(JSON.stringify({ v: 1, userId: swarm.userId, swarmId: swarm.id, agentId: agent.id, nonce: agent.credentialNonce })).toString("base64url");
    const signature = createHmac("sha256", this.credentialSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private async emit(swarm: RufloSwarm, type: string, payload: Record<string, unknown>): Promise<void> {
    const existing = await this.repository.listEvents(swarm.id, 0, 120);
    const sequence = (existing.at(-1)?.sequence ?? 0) + 1;
    await this.repository.createEvent({ id: randomUUID(), swarmId: swarm.id, sequence, type, payload: boundRecord(payload, 4_000), createdAt: this.now().toISOString() });
  }
}

export type AgentAuth = { agentId: string; credential: string };

export function parseAgentAuth(agentId: unknown, credential: unknown): AgentAuth {
  if (typeof agentId !== "string" || !agentId.trim() || typeof credential !== "string" || credential.length < 20 || credential.length > 4_000) {
    throw new RufloSwarmError("agent_unauthorized", "An agent ID and credential are required.");
  }
  return { agentId: agentId.trim(), credential };
}

export function topologyConnections(swarm: RufloSwarm, agents: readonly RufloAgent[]): Array<{ from: string; to: string; type: "peer" | "leader" | "worker" }> {
  if (swarm.topology === "mesh") {
    return agents.flatMap((from) => agents.filter((to) => to.id !== from.id).map((to) => ({ from: from.id, to: to.id, type: "peer" as const })));
  }
  const leader = agents.find((agent) => agent.id === swarm.leaderAgentId);
  return leader ? agents.filter((agent) => agent.id !== leader.id).flatMap((agent) => [
    { from: agent.id, to: leader.id, type: "leader" as const },
    { from: leader.id, to: agent.id, type: "worker" as const },
  ]) : [];
}

export function resolveRufloConflict(kind: "write_write" | "read_write" | "stale_workspace"): { resolution: "manual_review" | "retry"; reason: string } {
  return kind === "write_write"
    ? { resolution: "manual_review", reason: "Overlapping writes require an explicit proposal review; no agent wins implicitly." }
    : { resolution: "retry", reason: "The agent must refresh shared state and retry against the current workspace/context revision." };
}

function aggregateConsensus(consensus: RufloConsensus): void {
  const required = consensus.strategy === "quorum" ? Math.ceil(consensus.voterAgentIds.length * 2 / 3) : Math.floor(consensus.voterAgentIds.length / 2) + 1;
  if (consensus.votes.length < required) return;
  const groups = new Map<string, { value: unknown; count: number }>();
  for (const vote of consensus.votes) {
    const key = stableJson(vote.value);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { value: vote.value, count: 1 });
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count || stableJson(a.value).localeCompare(stableJson(b.value)));
  if (!ranked[0] || ranked[0].count < required) {
    consensus.status = "conflict";
    consensus.decision = undefined;
  } else {
    consensus.status = "reached";
    consensus.decision = ranked[0].value;
  }
}

function requireCapability(agent: RufloAgent, capability: string): void {
  if (!agent.capabilities.includes(capability)) throw new RufloSwarmError("capability_denied", `Agent ${agent.name} lacks ${capability}.`);
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new RufloSwarmError("invalid_input", `${label} is required.`);
  return value.trim();
}

function boundedId(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(value.trim()) ? value.trim() : fallback;
}

function boundedText(value: string, max: number): string {
  return String(value ?? "").trim().slice(0, max) || "Unnamed agent";
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback;
}

function boundRecord(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const bounded = boundJson(value, maxBytes);
  if (!bounded || typeof bounded !== "object" || Array.isArray(bounded)) throw new RufloSwarmError("invalid_payload", "Payload must be an object.");
  return bounded as Record<string, unknown>;
}

function boundJson(value: unknown, maxBytes: number): unknown {
  let result: unknown;
  try { result = JSON.parse(JSON.stringify(value ?? null)); } catch { throw new RufloSwarmError("invalid_payload", "Payload must be JSON serializable."); }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) throw new RufloSwarmError("payload_limit", "The payload exceeds the bounded swarm context limit.");
  return result;
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}