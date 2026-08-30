import { index, pgEnum, pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProjectUpdatedIdx: index("ruflo_memory_user_project_updated_idx").on(
      table.userId,
      table.projectKey,
      table.updatedAt,
    ),
  }),
);