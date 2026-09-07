import { pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionsTable = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceRoleEnum = pgEnum("workspace_role", ["owner", "collaborator", "viewer"]);

export const workspaceProjectsTable = pgTable(
  "workspace_projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerProjectUnique: uniqueIndex("workspace_projects_owner_project_unique").on(table.ownerId, table.projectId),
  }),
);

export const workspaceMembersTable = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaceProjectsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    role: workspaceRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceUserUnique: uniqueIndex("workspace_members_workspace_user_unique").on(table.workspaceId, table.userId),
  }),
);

export const githubCredentialsTable = pgTable("github_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  encryptedToken: text("encrypted_token").notNull(),
  nonce: text("nonce").notNull(),
  authTag: text("auth_tag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  status: text("status").notNull().default("invalid"),
});

export const userSecretsTable = pgTable("user_secrets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").references(() => workspaceProjectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  nonce: text("nonce").notNull(),
  authTag: text("auth_tag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  rotationReminderAt: timestamp("rotation_reminder_at", { withTimezone: true }),
  lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
}, (table) => ({
  userNameUnique: uniqueIndex("user_secrets_user_name_unique").on(table.userId, table.name),
  workspaceNameUnique: uniqueIndex("user_secrets_workspace_name_unique").on(table.workspaceId, table.name),
}));