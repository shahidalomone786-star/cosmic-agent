import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, sessionsTable, usersTable } from "@workspace/db";

export type AuthUser = { id: string; email: string };
export const SESSION_COOKIE = "cosmic_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function registerUser(email: string, password: string): Promise<AuthUser> {
  const passwordHash = await bcrypt.hash(password, 12);
  const id = randomUUID();
  const [user] = await db.insert(usersTable).values({ id, email: normalizeEmail(email), passwordHash }).returning({
    id: usersTable.id,
    email: usersTable.email,
  });
  if (!user) throw new Error("Unable to create account.");
  return user;
}

export async function authenticateUser(email: string, password: string): Promise<AuthUser | undefined> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizeEmail(email))).limit(1);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return undefined;
  return { id: user.id, email: user.email };
}

export async function createSession(userId: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await db.insert(sessionsTable).values({
    id,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return id;
}

export async function getUserForSession(sessionId: string | undefined): Promise<AuthUser | undefined> {
  if (!sessionId) return undefined;
  const [row] = await db
    .select({ id: usersTable.id, email: usersTable.email, expiresAt: sessionsTable.expiresAt })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);
  if (!row || row.expiresAt <= new Date()) {
    if (row) await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
    return undefined;
  }
  await db.update(sessionsTable).set({ lastUsedAt: new Date() }).where(eq(sessionsTable.id, sessionId));
  return { id: row.id, email: row.email };
}

export async function destroySession(sessionId: string | undefined): Promise<void> {
  if (sessionId) await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
}

export async function purgeExpiredSessions(): Promise<void> {
  await db.delete(sessionsTable).where(lt(sessionsTable.expiresAt, new Date()));
}