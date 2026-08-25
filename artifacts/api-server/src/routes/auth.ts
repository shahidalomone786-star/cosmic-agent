import { Router, type IRouter } from "express";
import { authenticateUser, createSession, destroySession, normalizeEmail, registerUser, SESSION_COOKIE } from "../lib/auth";

const router: IRouter = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" });
const credentials = (body: unknown) => {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return { email: typeof value.email === "string" ? normalizeEmail(value.email) : "", password: typeof value.password === "string" ? value.password : "" };
};

router.post("/auth/register", async (req, res): Promise<void> => {
  const { email, password } = credentials(req.body);
  if (!emailPattern.test(email) || password.length < 8 || password.length > 200) {
    res.status(400).json({ error: "Enter a valid email and a password of at least 8 characters." });
    return;
  }
  try {
    const user = await registerUser(email, password);
    const sessionId = await createSession(user.id);
    res.cookie(SESSION_COOKIE, sessionId, cookieOptions());
    res.status(201).json({ user });
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }
    throw error;
  }
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = credentials(req.body);
  const user = await authenticateUser(email, password);
  if (!user) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }
  res.cookie(SESSION_COOKIE, await createSession(user.id), cookieOptions());
  res.json({ user });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  await destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ success: true });
});

router.get("/auth/me", (req, res): void => {
  if (!req.authUser) {
    res.status(401).json({ error: "Authentication required.", code: "unauthorized" });
    return;
  }
  res.json({ user: req.authUser });
});

export default router;