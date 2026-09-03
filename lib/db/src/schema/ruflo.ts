import { index, uniqueIndex, pgEnum, pgTable, integer, real, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const rufloSessionStatusEnum = pgEnum("ruflo_session_status", [
  "created",
  "active",
  "completed",
  "failed",
  "cancelled",
]);

export const rufloTaskStatusEnum = pgEnum("ruflo_task_status", [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);

export const rufloMemoryKindEnum = pgEnum("ruflo_memory_kind", [
  "project_fact",
  "coding_pattern",
  "successful_solution",
  "failed_solution",
  "architecture_decision",
  "warning",
  "user_preference",
  "tool_pattern",
  // Retained so existing Phase 1 rows remain readable during the transition.
  "technology",
  "architecture",
  "success",
  "validation_problem",
]);

export const rufloSessionsTable = pgTable("ruflo_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  goal: text("goal").notNull(),
  status: rufloSessionStatusEnum("status").notNull().default("created"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rufloTasksTable = pgTable("ruflo_tasks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => rufloSessionsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: rufloTaskStatusEnum("status").notNull().default("pending"),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rufloActivitiesTable = pgTable("ruflo_activities", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => rufloSessionsTable.id, { onDelete: "cascade" }),
  taskId: text("task_id").references(() => rufloTasksTable.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rufloMemoryTable = pgTable(
  "ruflo_memory",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    projectKey: text("project_key").notNull(),
    kind: rufloMemoryKindEnum("kind").notNull(),
    fact: text("fact").notNull(),
    sourceSessionId: text("source_session_id").references(() => rufloSessionsTable.id, { onDelete: "set null" }),
    sourceTaskId: text("source_task_id").references(() => rufloTasksTable.id, { onDelete: "set null" }),
    fingerprint: text("fingerprint"),
    importance: integer("importance").notNull().default(50),
    confidence: real("confidence").notNull().default(0.5),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    embedding: text("embedding"),
    embeddingProvider: text("embedding_provider"),
    embeddingModel: text("embedding_model"),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProjectUpdatedIdx: index("ruflo_memory_user_project_updated_idx").on(
      table.userId,
      table.projectKey,
      table.updatedAt,
    ),
    userProjectKindIdx: index("ruflo_memory_user_project_kind_idx").on(
      table.userId,
      table.projectKey,
      table.kind,
    ),
    userProjectLastUsedIdx: index("ruflo_memory_user_project_last_used_idx").on(
      table.userId,
      table.projectKey,
      table.lastUsedAt,
    ),
    fingerprintIdx: index("ruflo_memory_fingerprint_idx").on(table.userId, table.projectKey, table.fingerprint),
  }),
);

export const rufloSwarmTopologyEnum = pgEnum("ruflo_swarm_topology", ["hierarchical", "mesh"]);
export const rufloSwarmStatusEnum = pgEnum("ruflo_swarm_status", ["created", "running", "completed", "failed", "cancelled"]);
export const rufloAgentStatusEnum = pgEnum("ruflo_agent_status", ["active", "idle", "busy", "expired", "terminated", "cancelled"]);
export const rufloSwarmMessageStatusEnum = pgEnum("ruflo_swarm_message_status", ["queued", "delivered", "acknowledged"]);
export const rufloSwarmTaskStatusEnum = pgEnum("ruflo_swarm_task_status", ["pending", "in_progress", "completed", "failed", "cancelled"]);
export const rufloConsensusStatusEnum = pgEnum("ruflo_consensus_status", ["open", "reached", "rejected", "conflict"]);

export const rufloSwarmsTable = pgTable(
  "ruflo_swarms",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => rufloSessionsTable.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    topology: rufloSwarmTopologyEnum("topology").notNull(),
    status: rufloSwarmStatusEnum("status").notNull().default("created"),
    leaderAgentId: text("leader_agent_id"),
    limits: jsonb("limits").notNull().default({}),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userSessionIdx: index("ruflo_swarms_user_session_idx").on(table.userId, table.sessionId),
  }),
);

export const rufloAgentsTable = pgTable(
  "ruflo_agents",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => rufloSwarmsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    role: text("role").notNull(),
    parentId: text("parent_id"),
    capabilities: jsonb("capabilities").notNull().default([]),
    metadata: jsonb("metadata").notNull().default({}),
    credentialNonce: text("credential_nonce").notNull(),
    status: rufloAgentStatusEnum("status").notNull().default("active"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    swarmNameIdx: uniqueIndex("ruflo_agents_swarm_name_idx").on(table.swarmId, table.name),
    swarmStatusIdx: index("ruflo_agents_swarm_status_idx").on(table.swarmId, table.status),
  }),
);

export const rufloSwarmMessagesTable = pgTable(
  "ruflo_swarm_messages",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => rufloSwarmsTable.id, { onDelete: "cascade" }),
    fromAgentId: text("from_agent_id").notNull().references(() => rufloAgentsTable.id, { onDelete: "cascade" }),
    toAgentId: text("to_agent_id").notNull().references(() => rufloAgentsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: rufloSwarmMessageStatusEnum("status").notNull().default("queued"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mailboxIdx: index("ruflo_swarm_messages_mailbox_idx").on(table.swarmId, table.toAgentId, table.status, table.createdAt),
  }),
);

export const rufloBlackboardTable = pgTable(
  "ruflo_blackboard",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => rufloSwarmsTable.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    version: integer("version").notNull().default(1),
    updatedByAgentId: text("updated_by_agent_id").notNull().references(() => rufloAgentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    swarmKeyIdx: uniqueIndex("ruflo_blackboard_swarm_key_idx").on(table.swarmId, table.namespace, table.key),
  }),
);

export const rufloSwarmSubscriptionsTable = pgTable(
  "ruflo_swarm_subscriptions",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => rufloSwarmsTable.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull().references(() => rufloAgentsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentEventIdx: uniqueIndex("ruflo_swarm_subscriptions_agent_event_idx").on(table.agentId, table.eventType),
  }),
);

export const rufloSwarmEventsTable = pgTable(
  "ruflo_swarm_events",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => rufloSwarmsTable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    swarmSequenceIdx: uniqueIndex("ruflo_swarm_events_sequence_idx").on(table.swarmId, table.sequence),
  }),
);

export const rufloSwarmTasksTable = pgTable(
  "ruflo_swarm_tasks",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => rufloSwarmsTable.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => rufloSessionsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: rufloSwarmTaskStatusEnum("status").notNull().default("pending"),
    assignedAgentId: text("assigned_agent_id").references(() => rufloAgentsTable.id, { onDelete: "set null" }),
    payload: jsonb("payload").notNull().default({}),
    result: jsonb("result"),
    error: text("error"),
    leaseOwnerAgentId: text("lease_owner_agent_id").references(() => rufloAgentsTable.id, { onDelete: "set null" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    swarmStatusIdx: index("ruflo_swarm_tasks_swarm_status_idx").on(table.swarmId, table.status),
  }),
);

export const rufloConsensusTable = pgTable(
  "ruflo_consensus",
  {
    id: text("id").primaryKey(),
    swarmId: text("swarm_id").notNull().references(() => rufloSwarmsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    strategy: text("strategy").notNull(),
    voterAgentIds: jsonb("voter_agent_ids").notNull(),
    votes: jsonb("votes").notNull().default([]),
    status: rufloConsensusStatusEnum("status").notNull().default("open"),
    decision: jsonb("decision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    swarmStatusIdx: index("ruflo_consensus_swarm_status_idx").on(table.swarmId, table.status),
  }),
);