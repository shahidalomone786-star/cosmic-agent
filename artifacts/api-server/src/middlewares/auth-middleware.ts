import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "../lib/auth";
import { getUserForSession, SESSION_COOKIE } from "../lib/auth";

const userStorage = new AsyncLocalStorage<AuthUser>();

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = await getUserForSession(req.cookies?.[SESSION_COOKIE]);
  req.authUser = user;
  if (user) userStorage.run(user, next);
  else next();
}

export function getCurrentAuthUser(): AuthUser | undefined {
  return userStorage.getStore();
}

export function requireAuthenticatedUser(req: Request, res: Response): AuthUser | undefined {
  if (!req.authUser) {
    res.status(401).json({ error: "Authentication required.", code: "unauthorized" });
    return undefined;
  }
  return req.authUser;
}