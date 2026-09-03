import type {
  RufloAgent,
  RufloBlackboardEntry,
  RufloConsensus,
  RufloSwarm,
  RufloSwarmEvent,
  RufloSwarmMessage,
  RufloSwarmRepository,
  RufloSwarmSubscription,
  RufloSwarmTask,
} from "./ruflo-swarm";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class InMemoryRufloSwarmRepository implements RufloSwarmRepository {
  private readonly swarms = new Map<string, RufloSwarm>();
  private readonly agents = new Map<string, RufloAgent>();
  private readonly messages = new Map<string, RufloSwarmMessage>();
  private readonly context = new Map<string, RufloBlackboardEntry>();
  private readonly subscriptions = new Map<string, RufloSwarmSubscription>();
  private readonly events = new Map<string, RufloSwarmEvent>();
  private readonly tasks = new Map<string, RufloSwarmTask>();
  private readonly consensus = new Map<string, RufloConsensus>();

  async createSwarm(value: RufloSwarm): Promise<RufloSwarm> { this.swarms.set(value.id, copy(value)); return copy(value); }
  async getSwarm(userId: string, swarmId: string): Promise<RufloSwarm | undefined> { const value = this.swarms.get(swarmId); return value?.userId === userId ? copy(value) : undefined; }
  async updateSwarm(value: RufloSwarm): Promise<RufloSwarm> { this.swarms.set(value.id, copy(value)); return copy(value); }
  async listAgents(swarmId: string): Promise<RufloAgent[]> { return [...this.agents.values()].filter((value) => value.swarmId === swarmId).map(copy); }
  async getAgent(swarmId: string, agentId: string): Promise<RufloAgent | undefined> { const value = this.agents.get(agentId); return value?.swarmId === swarmId ? copy(value) : undefined; }
  async createAgent(value: RufloAgent): Promise<RufloAgent> { this.agents.set(value.id, copy(value)); return copy(value); }
  async updateAgent(value: RufloAgent): Promise<RufloAgent> { this.agents.set(value.id, copy(value)); return copy(value); }
  async createMessage(value: RufloSwarmMessage): Promise<RufloSwarmMessage> { this.messages.set(value.id, copy(value)); return copy(value); }
  async listMailbox(swarmId: string, agentId: string, limit: number): Promise<RufloSwarmMessage[]> { return [...this.messages.values()].filter((value) => value.swarmId === swarmId && value.toAgentId === agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit).map(copy); }
  async getMessage(swarmId: string, messageId: string): Promise<RufloSwarmMessage | undefined> { const value = this.messages.get(messageId); return value?.swarmId === swarmId ? copy(value) : undefined; }
  async updateMessage(value: RufloSwarmMessage): Promise<RufloSwarmMessage> { this.messages.set(value.id, copy(value)); return copy(value); }
  async getBlackboard(swarmId: string, namespace: string, key: string): Promise<RufloBlackboardEntry | undefined> { const value = this.context.get(`${swarmId}:${namespace}:${key}`); return value ? copy(value) : undefined; }
  async listBlackboard(swarmId: string, namespace?: string): Promise<RufloBlackboardEntry[]> { return [...this.context.values()].filter((value) => value.swarmId === swarmId && (!namespace || value.namespace === namespace)).map(copy); }
  async upsertBlackboard(value: RufloBlackboardEntry, expectedVersion?: number): Promise<RufloBlackboardEntry> {
    const storageKey = `${value.swarmId}:${value.namespace}:${value.key}`;
    const current = this.context.get(storageKey);
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
      throw new Error(`Context changed at version ${current?.version ?? 0}.`);
    }
    this.context.set(storageKey, copy(value));
    return copy(value);
  }
  async createSubscription(value: RufloSwarmSubscription): Promise<RufloSwarmSubscription> { const existing = [...this.subscriptions.values()].find((item) => item.agentId === value.agentId && item.eventType === value.eventType); if (existing) return copy(existing); this.subscriptions.set(value.id, copy(value)); return copy(value); }
  async listSubscriptions(swarmId: string, agentId: string): Promise<RufloSwarmSubscription[]> { return [...this.subscriptions.values()].filter((value) => value.swarmId === swarmId && value.agentId === agentId).map(copy); }
  async createEvent(value: RufloSwarmEvent): Promise<RufloSwarmEvent> { this.events.set(value.id, copy(value)); return copy(value); }
  async listEvents(swarmId: string, afterSequence: number, limit: number): Promise<RufloSwarmEvent[]> { return [...this.events.values()].filter((value) => value.swarmId === swarmId && value.sequence > afterSequence).sort((a, b) => a.sequence - b.sequence).slice(0, limit).map(copy); }
  async createTask(value: RufloSwarmTask): Promise<RufloSwarmTask> { this.tasks.set(value.id, copy(value)); return copy(value); }
  async getTask(swarmId: string, taskId: string): Promise<RufloSwarmTask | undefined> { const value = this.tasks.get(taskId); return value?.swarmId === swarmId ? copy(value) : undefined; }
  async listTasks(swarmId: string): Promise<RufloSwarmTask[]> { return [...this.tasks.values()].filter((value) => value.swarmId === swarmId).map(copy); }
  async updateTask(value: RufloSwarmTask): Promise<RufloSwarmTask> { this.tasks.set(value.id, copy(value)); return copy(value); }
  async createConsensus(value: RufloConsensus): Promise<RufloConsensus> { this.consensus.set(value.id, copy(value)); return copy(value); }
  async getConsensus(swarmId: string, consensusId: string): Promise<RufloConsensus | undefined> { const value = this.consensus.get(consensusId); return value?.swarmId === swarmId ? copy(value) : undefined; }
  async updateConsensus(value: RufloConsensus): Promise<RufloConsensus> { this.consensus.set(value.id, copy(value)); return copy(value); }
  async recoverExpired(now: string): Promise<{ agents: number; tasks: number }> {
    let agents = 0; let tasks = 0;
    for (const value of this.agents.values()) if (value.leaseExpiresAt && value.leaseExpiresAt <= now && (value.status === "active" || value.status === "busy")) { value.status = "expired"; agents += 1; }
    for (const value of this.tasks.values()) if (value.leaseExpiresAt && value.leaseExpiresAt <= now && value.status === "in_progress") { value.status = "pending"; value.leaseOwnerAgentId = undefined; value.leaseExpiresAt = undefined; tasks += 1; }
    return { agents, tasks };
  }
}