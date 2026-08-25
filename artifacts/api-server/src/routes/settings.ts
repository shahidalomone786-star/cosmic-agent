import { Router, type IRouter } from "express";
import { getGitHubCredential, getGitHubCredentialStatus, removeGitHubCredential, saveGitHubCredential, updateGitHubCredentialStatus } from "../lib/github-credentials";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { validateGitHubToken } from "../repository/github-provider";

const router: IRouter = Router();
const safe = (status: "connected" | "invalid" | "rate_limited" | "unavailable") => ({ connected: status === "connected", status });

router.get("/settings/github", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;
  res.json(await getGitHubCredentialStatus(user.id));
});

router.post("/settings/github", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token || token.length > 500) {
    res.status(400).json({ error: "Enter a valid GitHub token." });
    return;
  }
  const result = await validateGitHubToken(token);
  if (result.status !== "connected") {
    res.status(result.status === "rate_limited" ? 429 : 422).json(safe(result.status));
    return;
  }
  await saveGitHubCredential(user.id, token, "connected", true);
  res.json(safe("connected"));
});

router.post("/settings/github/validate", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;
  const current = await getGitHubCredentialStatus(user.id);
  if (current.status === "not_connected") {
    res.json(current);
    return;
  }
  const credential = await getGitHubCredential(user.id);
  if (!credential) {
    res.json({ connected: false, status: "not_connected" });
    return;
  }
  const result = await validateGitHubToken(credential.token);
  if (result.status === "connected") {
    await updateGitHubCredentialStatus(user.id, "connected", true);
  } else if (result.status === "invalid" || result.status === "rate_limited" || result.status === "unavailable") {
    await updateGitHubCredentialStatus(user.id, result.status, false);
  }
  res.status(result.status === "rate_limited" ? 429 : 200).json(safe(result.status));
});

router.delete("/settings/github", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;
  await removeGitHubCredential(user.id);
  res.json({ connected: false, status: "not_connected" });
});

export default router;