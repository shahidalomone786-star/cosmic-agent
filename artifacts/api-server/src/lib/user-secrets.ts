import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, userSecretsTable } from "@workspace/db";
import { decryptGitHubToken, encryptGitHubToken } from "./github-crypto";

export type SecretMetadata = {
  id: string;
  name: string;
  maskedValue: string;
  createdAt: string;
  lastUsedAt: string | null;
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

function toMetadata(secret: Pick<SecretRow, "id" | "name" | "encryptedValue" | "nonce" | "authTag" | "createdAt" | "lastUsedAt">): SecretMetadata {
  const value = decryptGitHubToken(secret.encryptedValue, secret.nonce, secret.authTag);
  return {
    id: secret.id,
    name: secret.name,
    maskedValue: maskSecretValue(value),
    createdAt: secret.createdAt.toISOString(),
    lastUsedAt: secret.lastUsedAt?.toISOString() ?? null,
  };
}

export async function listUserSecrets(userId: string): Promise<SecretMetadata[]> {
  const rows = await db.select().from(userSecretsTable).where(eq(userSecretsTable.userId, userId)).orderBy(asc(userSecretsTable.name));
  return rows.map(toMetadata);
}

export async function createUserSecret(userId: string, name: string, value: string): Promise<SecretMetadata> {
  const [existing] = await db.select({ id: userSecretsTable.id })
    .from(userSecretsTable)
    .where(and(eq(userSecretsTable.userId, userId), eq(userSecretsTable.name, name)))
    .limit(1);
  if (existing) throw new SecretNameConflictError();
  const encrypted = encryptGitHubToken(value);
  const [row] = await db.insert(userSecretsTable).values({
    id: randomUUID(),
    userId,
    name,
    ...{
      encryptedValue: encrypted.encryptedToken,
      nonce: encrypted.nonce,
      authTag: encrypted.authTag,
    },
  }).returning();
  if (!row) throw new Error("Secret could not be created.");
  return toMetadata(row);
}

export async function rotateUserSecret(userId: string, secretId: string, value: string): Promise<SecretMetadata | undefined> {
  const encrypted = encryptGitHubToken(value);
  const [row] = await db.update(userSecretsTable).set({
    encryptedValue: encrypted.encryptedToken,
    nonce: encrypted.nonce,
    authTag: encrypted.authTag,
    updatedAt: new Date(),
  }).where(and(eq(userSecretsTable.id, secretId), eq(userSecretsTable.userId, userId))).returning();
  return row ? toMetadata(row) : undefined;
}

export async function deleteUserSecret(userId: string, secretId: string): Promise<boolean> {
  const deleted = await db.delete(userSecretsTable).where(and(eq(userSecretsTable.id, secretId), eq(userSecretsTable.userId, userId))).returning({ id: userSecretsTable.id });
  return deleted.length > 0;
}