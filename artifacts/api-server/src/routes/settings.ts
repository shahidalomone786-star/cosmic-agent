import { Router, type IRouter } from "express";
import { getGitHubCredential, getGitHubCredentialStatus, removeGitHubCredential, saveGitHubCredential, updateGitHubCredentialStatus } from "../lib/github-credentials";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { validateGitHubToken } from "../repository/github-provider";
import { providerManager } from "../ai/provider-manager";
import { createDefaultRufloToolRegistry } from "../ruflo/ruflo-tool-registry";
import { listRufloAuditRecords } from "../ruflo/ruflo-runtime";
import { buildControlCenterSnapshot } from "../ruflo/ruflo-control-center";

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
  await saveGitHubCredential(user.id, token, result.status, result.status === "connected");
  res.json(safe(result.status));
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

router.get("/settings/control-center", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;

  const github = await getGitHubCredentialStatus(user.id);
  const registry = createDefaultRufloToolRegistry();
  const tools = registry.list();
  const auditRecords = listRufloAuditRecords({ userId: user.id });
  res.json(buildControlCenterSnapshot({
    github,
    tools,
    auditRecords,
    models: providerManager.getModels(),
  }));
});

export default router;