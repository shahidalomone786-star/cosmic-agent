import { Router, type IRouter } from "express";
import { getGitHubCredential, getGitHubCredentialStatus, removeGitHubCredential, saveGitHubCredential, updateGitHubCredentialStatus } from "../lib/github-credentials";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { validateGitHubToken } from "../repository/github-provider";
import { providerManager } from "../ai/provider-manager";
import { createDefaultRufloToolRegistry } from "../ruflo/ruflo-tool-registry";
import { listRufloAuditRecords } from "../ruflo/ruflo-runtime";
import { buildControlCenterSnapshot } from "../ruflo/ruflo-control-center";
import { createUserSecret, deleteUserSecret, listUserSecrets, rotateUserSecret, SecretNameConflictError } from "../lib/user-secrets";
import { rufloToolAuditLog } from "../ruflo/ruflo-audit";

const router: IRouter = Router();
const safe = (status: "connected" | "invalid" | "rate_limited" | "unavailable") => ({ connected: status === "connected", status });
const secretValue = (body: unknown): string => typeof (body as { value?: unknown })?.value === "string" ? (body as { value: string }).value : "";
const secretName = (body: unknown): string => typeof (body as { name?: unknown })?.name === "string" ? (body as { name: string }).name.trim() : "";

function recordSecretAudit(userId: string, action: "create" | "rotate" | "delete", secretId: string, riskLevel: "LOW" | "DESTRUCTIVE" = "LOW"): void {
  rufloToolAuditLog.record({
    sessionId: `control-center:${secretId}`,
    userId,
    toolId: `control-center.secret.${action}`,
    source: "ruflo",
    riskLevel,
    approvalStatus: "not_required",
    executionStatus: "completed",
  });
}

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

router.get("/settings/secrets", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;
  res.json(await listUserSecrets(user.id));
});

router.post("/settings/secrets", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;
  const name = secretName(req.body);
  const value = secretValue(req.body);
  if (!name || name.length > 120 || !value || value.length > 10_000) {
    res.status(400).json({ error: "Enter a secret name and value." });
    return;
  }
  try {
    const secret = await createUserSecret(user.id, name, value);
    recordSecretAudit(user.id, "create", secret.id);
    res.status(201).json(secret);
  } catch (error) {
    if (error instanceof SecretNameConflictError) {
      res.status(409).json({ error: "A secret with this name already exists." });
      return;
    }
    res.status(500).json({ error: "Secret could not be stored securely." });
  }
});

router.post("/settings/secrets/:secretId/rotate", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;
  const value = secretValue(req.body);
  if (!value || value.length > 10_000) {
    res.status(400).json({ error: "Enter a replacement value." });
    return;
  }
  const secret = await rotateUserSecret(user.id, req.params.secretId, value);
  if (!secret) {
    res.status(404).json({ error: "Secret not found." });
    return;
  }
  recordSecretAudit(user.id, "rotate", secret.id);
  res.json(secret);
});

router.delete("/settings/secrets/:secretId", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;
  const deleted = await deleteUserSecret(user.id, req.params.secretId);
  if (!deleted) {
    res.status(404).json({ error: "Secret not found." });
    return;
  }
  recordSecretAudit(user.id, "delete", req.params.secretId, "DESTRUCTIVE");
  res.status(204).send();
});

router.get("/settings/control-center", async (req, res): Promise<void> => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return;

  const github = await getGitHubCredentialStatus(user.id);
  const secrets = await listUserSecrets(user.id);
  const registry = createDefaultRufloToolRegistry();
  const tools = registry.list();
  const auditRecords = listRufloAuditRecords({ userId: user.id });
  res.json(buildControlCenterSnapshot({
    github,
    secretCount: secrets.length,
    tools,
    auditRecords,
    models: providerManager.getModels(),
  }));
});

export default router;