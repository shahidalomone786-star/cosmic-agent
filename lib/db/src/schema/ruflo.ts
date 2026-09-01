import { index, pgEnum, pgTable, integer, real, text, timestamp, boolean } from "drizzle-orm/pg-core";
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