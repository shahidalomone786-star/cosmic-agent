import { Router, type IRouter, type Request } from "express";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { createWorkspaceDirectory, ensureWorkspace, inspectWorkspace, listWorkspace, readWorkspaceFile, removeWorkspacePath, renameWorkspacePath, searchWorkspace, writeWorkspaceFile } from "../workspace/local-workspace";
import { createLocalProposal } from "../workspace/local-proposal";
import { providerManager } from "../ai/provider-manager";
import { registerProposal } from "../repository/patch-executor";
import { registerLocalSession, getLocalSession } from "../workspace/local-session";
import type { AgentSession } from "../ai/agent-runtime";
import type { ChangeProposal } from "../ai/change-proposal";

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
router.get("/workspace/:projectId/inspect", async (req, res) => {
  try {
    const { inspectWorkspace } = await import("../workspace/local-workspace");
    const paths = typeof req.query.paths === "string" ? req.query.paths.split(",").filter(Boolean) : [];
    const request = typeof req.query.request === "string" ? req.query.request : "";
    res.json(await inspectWorkspace(user(req), project(req), paths, request));
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Workspace inspection failed." }); }
});
router.post("/workspace/:projectId/proposal", async (req, res) => {
  try {
    const request = typeof req.body?.request === "string" ? req.body.request.trim() : "";
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    const requestedPaths = Array.isArray(req.body?.paths) ? req.body.paths.filter((item: unknown): item is string => typeof item === "string") : [];
    const previousErrors = Array.isArray(req.body?.previousErrors) ? req.body.previousErrors.filter((item: unknown): item is string => typeof item === "string") : [];
    if (!request || !model) { res.status(400).json({ error: "Describe the coding task and select an approved model." }); return; }
    const root = await ensureWorkspace(user(req), project(req));
    const provider = providerManager.getProviderForModel(model);
    const workerInspection = await inspectWorkspace(user(req), project(req), requestedPaths, request);
    const workerTraceId = `local-${request.length}-${Date.now()}-worker`;
    const result = await createLocalProposal(provider, model, user(req), project(req), request, requestedPaths, previousErrors);
    const proposal = result.proposal;
    const review = reviewLocalProposal(proposal, workerInspection);
    const validator = validateLocalProposal(proposal);
    if (!review.approved) throw new Error("The reviewer stopped this proposal because its scope could not be verified.");
    if (!validator.approved) throw new Error("The validator stopped this proposal because a proposed target is not safe.");
    registerProposal(proposal, undefined, undefined, root, user(req), project(req));
    const timestamp = new Date().toISOString();
    const session: AgentSession & { proposalData: ChangeProposal } = {
      id: `local-${proposal.proposalId}`, ownerId: user(req), creatorName: user(req), task: request, status: "waiting_approval", currentStep: "observe", iteration: 1, maxIterations: 6,
      plan: [{ id: "understand", title: "Understand request", status: "complete" }, { id: "plan", title: "Plan workspace changes", status: "complete" }, { id: "retrieve_context", title: "Inspect relevant workspace files", status: "complete" }, { id: "act", title: "Create proposal", status: "complete" }, { id: "observe", title: "Wait for approval", status: "active" }, { id: "verify", title: "Validate and preview", status: "blocked" }, { id: "complete", title: "Complete", status: "blocked" }],
      selectedFiles: result.inspection.relevantFiles, discoveredFiles: result.inspection.structure.map((file) => file.path), selectedTools: ["workspace_list", "workspace_search", "workspace_read", "analyze_workspace", "create_proposal", "apply_approved_patch", "run_typecheck", "run_build"], activeModel: model, provider: provider.id,
      classification: { category: "MODERATE", confidence: 1, reason: "Local task grounded in bounded workspace inspection.", estimatedModelCalls: 1, estimatedToolCalls: 7 },
      managerPlan: { taskId: `local-${proposal.proposalId}`, goal: request, steps: proposal.plan.map((title, index) => ({ id: `local-step-${index + 1}`, title, description: title, assignedRole: "frontend" as const, dependencies: [], status: "PENDING" as const })), dependencies: [], estimatedToolCalls: 7, estimatedModelCalls: 1, complexity: "MODERATE", status: "ACTIVE" }, managerDecision: { action: "finalize", reason: "Approval-gated local file operations" }, managerReplanCount: 0, currentState: "WAITING_FOR_APPROVAL",
      contextMemory: { taskSummary: request, explicitFiles: requestedPaths, relevantFiles: result.inspection.filesRead, completedToolCalls: ["workspace_list", "workspace_search", ...result.inspection.filesRead.map((file) => `workspace_read:${file}`)], importantFindings: [`${result.inspection.structure.length} workspace entries inspected.`, `${result.inspection.dependencies.length} dependencies discovered.`], unresolvedQuestions: [], contextVersion: 1 },
      toolTraces: [
        { toolCallId: workerTraceId, taskId: `local-${proposal.proposalId}`, role: "frontend", tool: "workspace_read", status: "completed", startedAt: timestamp, completedAt: timestamp, inputSummary: "relevant workspace files", outputSummary: `${workerInspection.filesRead.length} files inspected` },
        { toolCallId: `local-${proposal.proposalId}-review`, taskId: `local-${proposal.proposalId}`, role: "reviewer", tool: "workspace_review", status: "completed", startedAt: timestamp, completedAt: timestamp, inputSummary: "proposal scope", outputSummary: "Proposal scope accepted" },
        { toolCallId: `local-${proposal.proposalId}-validator`, taskId: `local-${proposal.proposalId}`, role: "validator", tool: "workspace_validation", status: "completed", startedAt: timestamp, completedAt: timestamp, inputSummary: "target safety", outputSummary: "Target safety accepted" },
        { toolCallId: `local-${proposal.proposalId}-proposal`, taskId: `local-${proposal.proposalId}`, role: "frontend", tool: "create_proposal", status: "completed", startedAt: timestamp, completedAt: timestamp, inputSummary: "request accepted", outputSummary: `${proposal.files.length} files proposed` },
      ],
      providerBudget: { estimatedCalls: 1, estimatedTokens: Math.round(result.inspection.context.length / 4), status: "available" }, context: { filesIncluded: result.inspection.filesRead.length, approximateChars: result.inspection.context.length, chunked: result.inspection.context.length >= 64_000, warnings: [] }, toolResults: [{ tool: "workspace_list", status: "complete", summary: `${result.inspection.structure.length} workspace entries inspected.` }, { tool: "workspace_search", status: "complete", summary: "Request terms searched in readable workspace files." }, { tool: "workspace_read", status: "complete", summary: `${result.inspection.filesRead.length} relevant file(s) read.` }, { tool: "create_proposal", status: "complete", summary: `${proposal.files.length} approved operation(s) prepared.` }], memory: { completedTools: ["workspace_list", "workspace_search", "workspace_read", "create_proposal"], validationResults: [], contextNotes: ["GitHub is optional for local coding.", `${result.inspection.dependencies.length} dependencies were included in bounded context.`] },
      workerState: { assignedTasks: { frontend: request }, assignedSubtasks: { frontend: "local-frontend" }, relevantFiles: { frontend: workerInspection.relevantFiles }, completedToolIds: { frontend: [workerTraceId] }, findings: { frontend: ["Relevant workspace files were inspected before proposal generation."] }, dependencies: {}, validationResults: { validator: ["pass"] }, retryCounts: {} }, orchestration: { selectedWorkers: ["frontend", "reviewer", "validator"], queuedSubtasks: [], activeSubtasks: [], completedSubtasks: ["local-frontend", "local-reviewer", "local-validator"], workerReportIds: [], reviewStatus: "completed", reviewVerdict: "approve", transitionHistory: [] },
      events: [{ id: `local-event-1-${proposal.proposalId}`, type: "task_started", label: "Planning", detail: "The local coding task was accepted in Agent Mode.", timestamp }, { id: `local-event-2-${proposal.proposalId}`, type: "context_retrieval", label: "Reading project files", detail: `${workerInspection.structure.length} workspace entries inspected.`, timestamp }, { id: `local-event-3-${proposal.proposalId}`, type: "tool_called", label: "Frontend work completed", detail: `${workerInspection.filesRead.length} relevant file(s) read before proposal generation.`, timestamp }, { id: `local-event-4-${proposal.proposalId}`, type: "tool_called", label: "Review completed", detail: "The requested scope was accepted.", timestamp }, { id: `local-event-5-${proposal.proposalId}`, type: "tool_called", label: "Validation handoff ready", detail: "Target safety was confirmed; final checks remain approval-gated.", timestamp }, { id: `local-event-6-${proposal.proposalId}`, type: "proposal_generated", label: "Safe proposal generated", detail: `${proposal.files.length} operation(s) proposed.`, timestamp }, { id: `local-event-7-${proposal.proposalId}`, type: "approval_requested", label: "Approval required", detail: "No file operation occurs until approval.", timestamp }],
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

function reviewLocalProposal(proposal: ChangeProposal, inspection: Awaited<ReturnType<typeof inspectWorkspace>>): { approved: boolean } {
  const readable = new Set(inspection.filesRead);
  const approved = proposal.files.length > 0 && proposal.files.every((file) =>
    file.operation === "create" || file.operation === "directory_create" || readable.has(file.path) || (file.fromPath ? readable.has(file.fromPath) : false),
  );
  return { approved };
}

function validateLocalProposal(proposal: ChangeProposal): { approved: boolean } {
  return {
    approved: proposal.files.length > 0
      && proposal.files.every((file) => !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|mp[34-9]|exe|dll|so|dylib)$/i.test(file.path)),
  };
}