import { Router, type IRouter, type Request } from "express";
import { requireAuthenticatedUser } from "../middlewares/auth-middleware";
import { changeStats, createWorkspaceDirectory, ensureWorkspace, listWorkspace, readWorkspaceFile, removeWorkspacePath, renameWorkspacePath, searchWorkspace, writeWorkspaceFile } from "../workspace/local-workspace";
import { registerProposal } from "../repository/patch-executor";
import type { ChangeProposal } from "../ai/change-proposal";
import { workspaceProposalId } from "../workspace/local-workspace";

const router: IRouter = Router();
const localSessions = new Map<string, unknown>();
router.use((req, res, next) => requireAuthenticatedUser(req, res) ? next() : undefined);
const project = (req: Request) => typeof req.params.projectId === "string" ? req.params.projectId : "default";
const user = (req: Request) => req.authUser!.id;

router.post("/workspace/:projectId", async (req, res) => {
  try {
    const directory = await ensureWorkspace(user(req), project(req));
    res.status(201).json({ projectId: project(req), path: directory, files: await listWorkspace(user(req), project(req)) });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Workspace could not be created." }); }
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

router.post("/workspace/:projectId/racing-game/proposal", async (req, res) => {
  try {
    const files = [
      { path: "index.html", language: "html", proposedCode: `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cosmic Racing</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Cosmic Racing</h1><p>Arrow keys or WASD to steer. Avoid the asteroids.</p><canvas id="game" width="720" height="420"></canvas><div class="hud"><span>Score <b id="score">0</b></span><button id="restart">Restart race</button></div></main><script src="game.js"></script></body></html>`, explanation: "Creates the playable game shell and restart control." },
      { path: "style.css", language: "css", proposedCode: `:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#182d58,#070b18 70%);color:#eaf2ff}main{width:min(760px,92vw);text-align:center}canvas{width:100%;border:2px solid #6de4ff;border-radius:18px;background:#081126;box-shadow:0 0 50px #36d9ff33}.hud{display:flex;justify-content:space-between;align-items:center;margin-top:14px;font-size:1.1rem}button{border:0;border-radius:999px;padding:10px 18px;background:#ff9f68;color:#1b1020;font-weight:800;cursor:pointer}button:hover{filter:brightness(1.1)}`, explanation: "Adds readable game presentation and a clear restart action." },
      { path: "game.js", language: "javascript", proposedCode: `const canvas=document.querySelector("#game"),ctx=canvas.getContext("2d"),scoreEl=document.querySelector("#score"),restart=document.querySelector("#restart");let keys={},score=0,car,rocks,playing=false,frame=0;function reset(){score=0;frame=0;car={x:canvas.width/2-18,y:canvas.height-70,w:36,h:52,speed:6};rocks=[];playing=true;scoreEl.textContent="0";requestAnimationFrame(loop)}function hit(a,b){return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y}function loop(){if(!playing)return;frame++;if(keys.ArrowLeft||keys.a)car.x-=car.speed;if(keys.ArrowRight||keys.d)car.x+=car.speed;car.x=Math.max(10,Math.min(canvas.width-car.w-10,car.x));if(frame%34===0)rocks.push({x:20+Math.random()*(canvas.width-60),y:-40,w:34,h:34,speed:3+Math.random()*3});rocks=rocks.map(r=>({...r,y:r.y+r.speed})).filter(r=>r.y<canvas.height+60);if(rocks.some(r=>hit(car,r))){playing=false;ctx.fillStyle="#ff9f68";ctx.font="28px system-ui";ctx.fillText("Race over — press Restart",190,210);return}score++;scoreEl.textContent=String(score);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle="#34d9ff";ctx.fillRect(car.x,car.y,car.w,car.h);ctx.fillStyle="#ff648e";rocks.forEach(r=>{ctx.beginPath();ctx.arc(r.x+r.w/2,r.y+r.h/2,r.w/2,0,Math.PI*2);ctx.fill()});requestAnimationFrame(loop)}addEventListener("keydown",e=>{keys[e.key]=true});addEventListener("keyup",e=>{keys[e.key]=false});restart.addEventListener("click",reset);reset();`, explanation: "Implements the car, keyboard controls, score, collision loop, and restart behavior." },
    ];
    const current = await Promise.all(files.map(async (file) => {
      try { return { ...file, originalCode: (await readWorkspaceFile(user(req), project(req), file.path)).content, operation: "edit" as const }; }
      catch { return { ...file, originalCode: "", operation: "create" as const }; }
    }));
    const proposalFiles = current.map((file) => ({ ...file, diff: `--- /dev/null\n+++ b/${file.path}\n@@ create @@\n+${file.proposedCode}`, ...(file.operation === "create" ? { addedLines: file.proposedCode.split("\n").length, removedLines: 0 } : changeStats(file.originalCode, file.proposedCode)) }));
    const proposal: ChangeProposal = { proposalId: workspaceProposalId(proposalFiles, `${user(req)}:${project(req)}`), status: "proposal", summary: "Create a playable Cosmic Racing game", explanation: "A local workspace proposal for a keyboard-controlled racing game. Nothing is written until approval.", risk: "LOW", files: proposalFiles, affectedFiles: proposalFiles.map((file) => file.path), addedLines: proposalFiles.reduce((n, file) => n + file.addedLines, 0), removedLines: proposalFiles.reduce((n, file) => n + file.removedLines, 0) };
    registerProposal(proposal, undefined, undefined, await ensureWorkspace(user(req), project(req)));
    const timestamp = new Date().toISOString();
    const session = {
      id: `local-${proposal.proposalId}`, creatorName: user(req), task: "Create a simple racing game with a car, keyboard controls, score, and restart button.",
      status: "waiting_approval", currentStep: "observe", iteration: 1, maxIterations: 6, plan: [
        { id: "understand", title: "Understand request", status: "complete" }, { id: "plan", title: "Plan safe workspace changes", status: "complete" },
        { id: "retrieve_context", title: "Inspect local workspace", status: "complete" }, { id: "act", title: "Create approved files", status: "active" },
        { id: "observe", title: "Wait for approval", status: "active" }, { id: "verify", title: "Validate and preview", status: "blocked" }, { id: "complete", title: "Complete", status: "blocked" },
      ], selectedFiles: proposal.files.map((file) => file.path), discoveredFiles: [], selectedTools: ["workspace_list", "workspace_write", "run_typecheck", "run_build"], activeModel: "local-workspace", provider: "local",
      classification: { category: "SIMPLE", confidence: 1, reasoning: "Local workspace creation", estimatedModelCalls: 0, estimatedToolCalls: 4 },
      managerPlan: { objective: "Create a local playable game", steps: [] }, managerDecision: { action: "execute", rationale: "Approval-gated local file creation", subtasks: [] }, managerReplanCount: 0, currentState: "WAITING_FOR_APPROVAL",
      contextMemory: { taskSummary: "Local racing game", explicitFiles: [], relevantFiles: [], completedToolCalls: ["workspace_list"], importantFindings: ["No GitHub connection required"], unresolvedQuestions: [], contextVersion: 1 },
      toolTraces: proposal.files.map((file, index) => ({ toolCallId: `local-${proposal.proposalId}-${index}`, taskId: `local-${proposal.proposalId}`, role: "manager", tool: "workspace_write", status: "pending", startedAt: timestamp, inputSummary: `path=${file.path}` })),
      providerBudget: { estimatedCalls: 0, estimatedTokens: 0, status: "not_applicable" }, context: { filesIncluded: 0, approximateChars: 0, chunked: false, warnings: [] },
      toolResults: [], memory: { completedTools: ["workspace_list"], validationResults: [], contextNotes: ["GitHub is optional for this local project."] },
      workerState: { assignedTasks: {}, assignedSubtasks: {}, relevantFiles: {}, completedToolIds: {}, findings: {}, dependencies: {}, validationResults: {}, retryCounts: {} },
      orchestration: { selectedWorkers: ["frontend"], queuedSubtasks: [], activeSubtasks: [], completedSubtasks: [], workerReportIds: [], reviewStatus: "pending", transitionHistory: [] },
      events: [
        { id: `local-event-1-${proposal.proposalId}`, type: "task_started", label: "Planning", detail: "Local workspace run initialized.", timestamp },
        { id: `local-event-2-${proposal.proposalId}`, type: "context_retrieval", label: "Inspecting local workspace", detail: "GitHub was not required.", timestamp },
        { id: `local-event-3-${proposal.proposalId}`, type: "proposal_generated", label: "Creating proposal", detail: `${proposal.files.length} files, ${proposal.addedLines} lines added.`, timestamp },
        { id: `local-event-4-${proposal.proposalId}`, type: "approval_requested", label: "Approval required", detail: "No file write occurs until approval.", timestamp },
      ], createdAt: timestamp, updatedAt: timestamp, proposal: { proposalId: proposal.proposalId, files: proposal.files.map((file) => file.path), risk: proposal.risk, summary: proposal.summary }, proposalData: proposal,
    };
    localSessions.set(proposal.proposalId, session);
    res.status(201).json({ proposal, projectId: project(req), session });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Local proposal could not be created." }); }
});

router.get("/workspace/:projectId/activity/:proposalId", (req, res) => {
  const session = localSessions.get(req.params.proposalId);
  if (!session) { res.status(404).json({ error: "Local activity session not found." }); return; }
  res.json(session);
});

export default router;