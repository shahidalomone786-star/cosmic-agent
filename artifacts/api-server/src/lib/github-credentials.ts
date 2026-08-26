import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, githubCredentialsTable } from "@workspace/db";
import { decryptGitHubToken, encryptGitHubToken } from "./github-crypto";

export type GitHubCredentialStatus = "connected" | "invalid" | "rate_limited" | "unavailable";
export { decryptGitHubToken, encryptGitHubToken } from "./github-crypto";

export async function getGitHubCredential(userId: string): Promise<{ token: string; status: GitHubCredentialStatus } | undefined> {
  const [credential] = await db.select().from(githubCredentialsTable).where(eq(githubCredentialsTable.userId, userId)).limit(1);
  if (!credential) return undefined;
  return { token: decryptGitHubToken(credential.encryptedToken, credential.nonce, credential.authTag), status: credential.status as GitHubCredentialStatus };
}

export async function getGitHubCredentialStatus(userId: string): Promise<{ connected: boolean; status: "connected" | "invalid" | "rate_limited" | "unavailable" | "not_connected"; lastValidatedAt: Date | null }> {
  const [credential] = await db.select({ status: githubCredentialsTable.status, lastValidatedAt: githubCredentialsTable.lastValidatedAt }).from(githubCredentialsTable).where(eq(githubCredentialsTable.userId, userId)).limit(1);
  if (!credential) return { connected: false, status: "not_connected", lastValidatedAt: null };
  return { connected: credential.status === "connected", status: credential.status as GitHubCredentialStatus, lastValidatedAt: credential.lastValidatedAt };
}

export async function saveGitHubCredential(userId: string, token: string, status: GitHubCredentialStatus, validated: boolean): Promise<void> {
  const encrypted = encryptGitHubToken(token);
  const now = new Date();
  await db.insert(githubCredentialsTable).values({
    id: randomUUID(),
    userId,
    ...encrypted,
    status,
    lastValidatedAt: validated ? now : null,
  }).onConflictDoUpdate({
    target: githubCredentialsTable.userId,
    set: { ...encrypted, status, updatedAt: now, lastValidatedAt: validated ? now : null },
  });
}

export async function updateGitHubCredentialStatus(userId: string, status: GitHubCredentialStatus, validated: boolean): Promise<void> {
  const now = new Date();
  await db.update(githubCredentialsTable).set({ status, updatedAt: now, lastValidatedAt: validated ? now : undefined }).where(eq(githubCredentialsTable.userId, userId));
}

export async function removeGitHubCredential(userId: string): Promise<void> {
  await db.delete(githubCredentialsTable).where(eq(githubCredentialsTable.userId, userId));
}