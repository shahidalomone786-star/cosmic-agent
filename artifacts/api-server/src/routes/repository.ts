import { Router, type IRouter } from "express";
import { connectRepository, listTree, readRepositoryFile, searchRepository, RepositoryError, type RepositoryRef } from "../repository/github-provider";

const router: IRouter = Router();
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object");
const isRepositoryRef = (value: unknown): value is RepositoryRef => isRecord(value) && typeof value.owner === "string" && typeof value.name === "string" && typeof value.branch === "string" && typeof value.defaultBranch === "string" && typeof value.id === "string" && typeof value.webUrl === "string";
const sendError = (res: { status: (code: number) => { json: (value: unknown) => void } }, error: unknown) => {
  if (error instanceof RepositoryError) {
    const status = error.code === "rate_limited" ? 429 : error.code === "permission_denied" ? 403 : error.code === "not_found" ? 404 : 400;
    res.status(status).json({ error: error.message, code: error.code }); return;
  }
  res.status(503).json({ error: "Repository access is temporarily unavailable.", code: "network" });
};
router.post("/repository/connect", async (req, res) => {
  const repositoryUrl = isRecord(req.body) && typeof req.body.repositoryUrl === "string" ? req.body.repositoryUrl : "";
  const branch = isRecord(req.body) && typeof req.body.branch === "string" ? req.body.branch : undefined;
  if (!repositoryUrl.startsWith("http")) { res.status(400).json({ error: "Enter a valid repository URL." }); return; }
  try { res.json(await connectRepository(repositoryUrl, branch)); } catch (error) { sendError(res, error); }
});
router.post("/repository/tree", async (req, res) => {
  const repository = isRecord(req.body) ? req.body.repository : undefined;
  const path = isRecord(req.body) && typeof req.body.path === "string" ? req.body.path : undefined;
  if (!isRepositoryRef(repository)) { res.status(400).json({ error: "Invalid repository reference." }); return; }
  try { res.json(await listTree(repository, path)); } catch (error) { sendError(res, error); }
});
router.post("/repository/file", async (req, res) => {
  const repository = isRecord(req.body) ? req.body.repository : undefined;
  const path = isRecord(req.body) && typeof req.body.path === "string" ? req.body.path : "";
  if (!isRepositoryRef(repository) || !path) { res.status(400).json({ error: "Invalid file request." }); return; }
  try { res.json(await readRepositoryFile(repository, path)); } catch (error) { sendError(res, error); }
});
router.post("/repository/search", async (req, res) => {
  const repository = isRecord(req.body) ? req.body.repository : undefined;
  const query = isRecord(req.body) && typeof req.body.query === "string" ? req.body.query : "";
  if (!isRepositoryRef(repository) || !query) { res.status(400).json({ error: "Enter a search term." }); return; }
  try { res.json(await searchRepository(repository, query)); } catch (error) { sendError(res, error); }
});
export default router;