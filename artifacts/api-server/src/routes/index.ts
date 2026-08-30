import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import repositoryRouter from "./repository";
import authRouter from "./auth";
import settingsRouter from "./settings";
import { getPreview, proxyPreview, startPreview, stopPreview } from "../preview-runtime";
import { findWorkspaceProposal, getRegisteredProposal } from "../repository/patch-executor";
import workspaceRouter from "./workspace";
import rufloRouter from "./ruflo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(repositoryRouter);
router.use(authRouter);
router.use(settingsRouter);
router.use(workspaceRouter);
router.use(rufloRouter);

router.use((req, res, next) => {
  if (!req.path.startsWith("/preview")) { next(); return; }
  if (!req.authUser) { res.status(401).json({ error: "Authenticated user required." }); return; }
  next();
});
router.get("/preview/:proposalId/status", (req, res) => {
  try { res.json(getPreview(req.params.proposalId, req.authUser?.id)); }
  catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "Preview not found." }); }
});
router.post("/preview/:proposalId/start", async (req, res) => {
  try { res.json(await startPreview(req.params.proposalId, req.authUser?.id)); }
  catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : "Preview could not start." }); }
});
router.post("/preview/:proposalId/restart", async (req, res) => {
  try { res.json(await startPreview(req.params.proposalId, req.authUser?.id)); }
  catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : "Preview could not restart." }); }
});
router.post("/preview/:proposalId/stop", async (req, res) => {
  try { res.json(await stopPreview(req.params.proposalId, req.authUser?.id)); }
  catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "Preview could not stop." }); }
});
router.use("/preview/:proposalId", (req, res) => { void proxyPreview(req, res, req.params.proposalId, req.authUser?.id); });

router.get("/workspace/:projectId/preview/status", (req, res) => {
  try {
    const proposalId = findWorkspaceProposal(req.authUser!.id, req.params.projectId);
    if (!proposalId) { res.status(404).json({ error: "No approved preview exists for this project." }); return; }
    res.json(getPreview(proposalId, req.authUser!.id));
  } catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "Preview not found." }); }
});

export default router;
