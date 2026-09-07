import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, userSecretsTable } from "@workspace/db";
import { decryptGitHubToken, encryptGitHubToken } from "./github-crypto";

export type SecretMetadata = {
  id: string;
  name: string;
  maskedValue: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  rotationReminderAt: string | null;
  lastRotatedAt: string | null;
  expired: boolean;
};

type SecretRow = typeof userSecretsTable.$inferSelect;

export class SecretNameConflictError extends Error {
  constructor() {
    super("A secret with this name already exists.");
    this.name = "SecretNameConflictError";
  }
}

export function maskSecretValue(value: string): string {
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

function toMetadata(secret: Pick<SecretRow, "id" | "name" | "encryptedValue" | "nonce" | "authTag" | "createdAt" | "lastUsedAt" | "expiresAt" | "rotationReminderAt" | "lastRotatedAt">): SecretMetadata {
  let maskedValue = "••••";
  try {
    maskedValue = maskSecretValue(decryptGitHubToken(secret.encryptedValue, secret.nonce, secret.authTag));
  } catch {
    // Preserve the row so authenticated users can still rotate or delete a
    // value that was encrypted under an unavailable or rotated key.
  }
  return {
    id: secret.id,
    name: secret.name,
    maskedValue,
    createdAt: secret.createdAt.toISOString(),
    lastUsedAt: secret.lastUsedAt?.toISOString() ?? null,
    expiresAt: secret.expiresAt?.toISOString() ?? null,
    rotationReminderAt: secret.rotationReminderAt?.toISOString() ?? null,
    lastRotatedAt: secret.lastRotatedAt?.toISOString() ?? null,
    expired: Boolean(secret.expiresAt && secret.expiresAt <= new Date()),
  };
}

export async function listUserSecrets(userId: string, workspaceId?: string): Promise<SecretMetadata[]> {
  const scope = workspaceId
    ? eq(userSecretsTable.workspaceId, workspaceId)
    : and(eq(userSecretsTable.userId, userId), isNull(userSecretsTable.workspaceId));
  const rows = await db.select().from(userSecretsTable).where(scope).orderBy(asc(userSecretsTable.name));
  return rows.map(toMetadata);
}

export async function createUserSecret(userId: string, name: string, value: string, workspaceId?: string, expiresAt?: Date | null, rotationReminderAt?: Date | null): Promise<SecretMetadata> {
  const [existing] = await db.select({ id: userSecretsTable.id })
    .from(userSecretsTable)
    .where(workspaceId
      ? and(eq(userSecretsTable.workspaceId, workspaceId), eq(userSecretsTable.name, name))
      : and(eq(userSecretsTable.userId, userId), eq(userSecretsTable.name, name), isNull(userSecretsTable.workspaceId)))
    .limit(1);
  if (existing) throw new SecretNameConflictError();
  const encrypted = encryptGitHubToken(value);
  const [row] = await db.insert(userSecretsTable).values({
    id: randomUUID(),
    userId,
    workspaceId,
    name,
    ...{
      encryptedValue: encrypted.encryptedToken,
      nonce: encrypted.nonce,
      authTag: encrypted.authTag,
    },
    expiresAt,
    rotationReminderAt,
    lastRotatedAt: new Date(),
  }).returning();
  if (!row) throw new Error("Secret could not be created.");
  return toMetadata(row);
}

export async function rotateUserSecret(userId: string, secretId: string, value: string, workspaceId?: string, expiresAt?: Date | null, rotationReminderAt?: Date | null): Promise<SecretMetadata | undefined> {
  const encrypted = encryptGitHubToken(value);
  const [row] = await db.update(userSecretsTable).set({
    encryptedValue: encrypted.encryptedToken,
    nonce: encrypted.nonce,
    authTag: encrypted.authTag,
    updatedAt: new Date(),
    lastRotatedAt: new Date(),
    expiresAt,
    rotationReminderAt,
  }).where(and(eq(userSecretsTable.id, secretId), workspaceId ? eq(userSecretsTable.workspaceId, workspaceId) : and(eq(userSecretsTable.userId, userId), isNull(userSecretsTable.workspaceId)))).returning();
  return row ? toMetadata(row) : undefined;
}

export async function deleteUserSecret(userId: string, secretId: string, workspaceId?: string): Promise<boolean> {
  const deleted = await db.delete(userSecretsTable).where(and(eq(userSecretsTable.id, secretId), workspaceId ? eq(userSecretsTable.workspaceId, workspaceId) : and(eq(userSecretsTable.userId, userId), isNull(userSecretsTable.workspaceId)))).returning({ id: userSecretsTable.id });
  return deleted.length > 0;
}