import { Router, type IRouter, type Request } from "express";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { createWorkspaceDirectory, ensureWorkspace, listWorkspace, readWorkspaceFile, removeWorkspacePath, renameWorkspacePath, searchWorkspace, writeWorkspaceFile } from "../workspace/local-workspace";
import { generateLocalProject, toLocalProposalFiles } from "../workspace/local-project";
import { registerProposal } from "../repository/patch-executor";
import type { ChangeProposal } from "../ai/change-proposal";
import { workspaceProposalId } from "../workspace/local-workspace";
import { registerLocalSession, getLocalSession } from "../workspace/local-session";
import type { AgentSession } from "../ai/agent-runtime";

const router: IRouter = Router();
router.use((req, res, next) => requireAuthenticatedUser(req, res) ? next() : undefined);
const project = (req: Request) => typeof req.params.projectId === "string" ? req.params.projectId : "default";
const user = (req: Request) => req.authUser!.id;

router.post("/workspace/:projectId", async (req, res) => {
  try { const directory = await ensureWorkspace(user(req), project(req)); res.status(201).json({ projectId: project(req), path: directory, files: await listWorkspace(user(req), project(req)) }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Workspace could not be created." }); }
});
router.get("/workspace/:projectId/files", async (req, res) => {
  try { res.json(await listWorkspace(user(req), project(req), typeof req.query.path === "string" ? req.query.path : "")); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Workspace could not be read." }); }
});
router.post("/workspace/:projectId/file", async (req, res) => {
  try { res.status(201).json(await writeWorkspaceFile(user(req), project(req), String(req.body?.path ?? ""), String(req.body?.content ?? ""))); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "File could not be written." }); }
});
router.get("/workspace/:projectId/file", async (req, res) => {
  try { res.json(await readWorkspaceFile(user(req), project(req), String(req.query.path ?? ""))); }
  catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "File could not be read." }); }
});
router.delete("/workspace/:projectId/file", async (req, res) => {
  try { await removeWorkspacePath(user(req), project(req), String(req.query.path ?? "")); res.json({ status: "deleted", path: req.query.path }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "File could not be deleted." }); }
});
router.post("/workspace/:projectId/directory", async (req, res) => {
  try { await createWorkspaceDirectory(user(req), project(req), String(req.body?.path ?? "")); res.status(201).json({ status: "created", path: req.body?.path }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Directory could not be created." }); }
});
router.post("/workspace/:projectId/rename", async (req, res) => {
  try { await renameWorkspacePath(user(req), project(req), String(req.body?.from ?? ""), String(req.body?.to ?? "")); res.json({ status: "renamed", from: req.body?.from, to: req.body?.to }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Workspace path could not be renamed." }); }
});
router.get("/workspace/:projectId/search", async (req, res) => {
  try { res.json(await searchWorkspace(user(req), project(req), String(req.query.q ?? ""))); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Workspace search failed." }); }
});
router.post("/workspace/:projectId/proposal", async (req, res) => {
  try {
    const request = typeof req.body?.request === "string" ? req.body.request.trim() : "";
    if (!request) { res.status(400).json({ error: "Describe the project you want to create." }); return; }
    const root = await ensureWorkspace(user(req), project(req));
    const proposalFiles = await toLocalProposalFiles(generateLocalProject(request), (filePath) => readWorkspaceFile(user(req), project(req), filePath).then((file) => file.content));
    const proposal: ChangeProposal = {
      proposalId: workspaceProposalId(proposalFiles, `${user(req)}:${project(req)}`), status: "proposal",
      summary: `Create ${project(req)} project`, explanation: "A server-generated local project proposal. Nothing is written until approval.",
      risk: "LOW", files: proposalFiles, affectedFiles: proposalFiles.map((file) => file.path),
      addedLines: proposalFiles.reduce((total, file) => total + file.addedLines, 0), removedLines: proposalFiles.reduce((total, file) => total + file.removedLines, 0),
    };
    registerProposal(proposal, undefined, undefined, root, user(req), project(req));
    const timestamp = new Date().toISOString();
    const session: AgentSession & { proposalData: ChangeProposal } = {
      id: `local-${proposal.proposalId}`, ownerId: user(req), creatorName: user(req), task: request, status: "waiting_approval", currentStep: "observe", iteration: 1, maxIterations: 6,
      plan: [{ id: "understand", title: "Understand request", status: "complete" }, { id: "plan", title: "Plan workspace changes", status: "complete" }, { id: "retrieve_context", title: "Read workspace context", status: "complete" }, { id: "act", title: "Create proposal", status: "complete" }, { id: "observe", title: "Wait for approval", status: "active" }, { id: "verify", title: "Validate and preview", status: "blocked" }, { id: "complete", title: "Complete", status: "blocked" }],
      selectedFiles: proposal.files.map((file) => file.path), discoveredFiles: [], selectedTools: ["workspace_list", "workspace_write", "run_typecheck", "run_build"], activeModel: "local-workspace", provider: "local",
      classification: { category: "SIMPLE", confidence: 1, reason: "Local project proposal", estimatedModelCalls: 0, estimatedToolCalls: 4 },
      managerPlan: { taskId: `local-${proposal.proposalId}`, goal: request, steps: [], dependencies: [], estimatedToolCalls: 4, estimatedModelCalls: 0, complexity: "SIMPLE", status: "ACTIVE" }, managerDecision: { action: "finalize", reason: "Approval-gated local file creation" }, managerReplanCount: 0, currentState: "WAITING_FOR_APPROVAL",
      contextMemory: { taskSummary: request, explicitFiles: [], relevantFiles: [], completedToolCalls: ["workspace_list"], importantFindings: ["GitHub is optional"], unresolvedQuestions: [], contextVersion: 1 },
      toolTraces: [{ toolCallId: `local-${proposal.proposalId}-proposal`, taskId: `local-${proposal.proposalId}`, role: "manager", tool: "create_proposal", status: "completed", startedAt: timestamp, completedAt: timestamp, inputSummary: "request accepted", outputSummary: `${proposal.files.length} files proposed` }],
      providerBudget: { estimatedCalls: 0, estimatedTokens: 0, status: "unknown" }, context: { filesIncluded: 0, approximateChars: 0, chunked: false, warnings: [] }, toolResults: [], memory: { completedTools: ["workspace_list", "create_proposal"], validationResults: [], contextNotes: ["GitHub is optional for local projects."] },
      workerState: { assignedTasks: {}, assignedSubtasks: {}, relevantFiles: {}, completedToolIds: {}, findings: {}, dependencies: {}, validationResults: {}, retryCounts: {} }, orchestration: { selectedWorkers: ["frontend"], queuedSubtasks: [], activeSubtasks: [], completedSubtasks: [], workerReportIds: [], reviewStatus: "pending", transitionHistory: [] },
      events: [{ id: `local-event-1-${proposal.proposalId}`, type: "task_started", label: "Planning", detail: "Local workspace run initialized.", timestamp }, { id: `local-event-2-${proposal.proposalId}`, type: "context_retrieval", label: "Reading context", detail: "Current project files were checked.", timestamp }, { id: `local-event-3-${proposal.proposalId}`, type: "proposal_generated", label: "Creating proposal", detail: `${proposal.files.length} files proposed.`, timestamp }, { id: `local-event-4-${proposal.proposalId}`, type: "approval_requested", label: "Waiting for approval", detail: "No file write occurs until approval.", timestamp }],
      createdAt: timestamp, updatedAt: timestamp, proposal: { proposalId: proposal.proposalId, files: proposal.files.map((file) => file.path), risk: proposal.risk, summary: proposal.summary }, proposalData: proposal,
    };
    registerLocalSession(proposal.proposalId, user(req), project(req), session);
    res.status(201).json({ proposal, projectId: project(req), session });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Local proposal could not be created." }); }
});
router.get("/workspace/:projectId/activity/:proposalId", (req, res) => {
  const session = getLocalSession(req.params.proposalId, user(req), project(req));
  if (!session) { res.status(404).json({ error: "Local activity session not found." }); return; }
  res.json(session);
});

export default router;