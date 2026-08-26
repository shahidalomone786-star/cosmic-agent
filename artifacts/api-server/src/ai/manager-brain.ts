import { randomUUID } from "node:crypto";
import type { AiModel } from "./ai-provider";

export const MAX_PLAN_STEPS = 15;
export const MAX_SUBTASKS = 6;
export const MAX_REPLANS = 2;
export const MAX_MANAGER_ITERATIONS = 10;
export const MAX_TOOL_CALLS = 20;
export const MAX_CONTEXT_RETRIES = 2;
export const MAX_CLASSIFICATION_RETRIES = 1;

export const ROLE_SYSTEM_PROMPTS = {
  manager: "You are the Cosmic Agent Manager. Plan tasks, delegate correctly, protect user intent, and never bypass approval or security boundaries.",
  frontend: "You are the Cosmic Agent Frontend Worker. Safely inspect and modify frontend code only through approved tools and proposals. Never bypass security or approval.",
  backend: "You are the Cosmic Agent Backend Worker. Build reliable server-side functionality while preserving authentication, provider, database, tool, and security boundaries.",
  reviewer: "You are the Cosmic Agent Reviewer. Inspect proposed work critically, verify evidence, detect regressions, and reject unsafe or unsupported changes.",
  validator: "You are the Cosmic Agent Validator. Verify the applied result against the proposal, tests, repository state, and security rules. Never fabricate evidence.",
} as const;

export const COSMIC_AGENT_CREATOR = "Shahid";

export type TaskCategory =
  | "SIMPLE"
  | "MODERATE"
  | "COMPLEX"
  | "REVIEW_ONLY"
  | "CLARIFICATION_REQUIRED";

export interface TaskClassification {
  category: TaskCategory;
  confidence: number;
  reason: string;
  estimatedToolCalls: number;
  estimatedModelCalls: number;
}

export type PlanStatus = "PENDING" | "ACTIVE" | "COMPLETED" | "FAILED" | "BLOCKED";
export type PlanRole = "manager" | "frontend" | "backend" | "reviewer" | "validator";

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  status: PlanStatus;
  assignedRole?: PlanRole;
  dependencies: string[];
}

export interface TaskDependency {
  fromStep: string;
  toStep: string;
  reason: string;
}

export interface AgentPlan {
  taskId: string;
  goal: string;
  steps: PlanStep[];
  dependencies: TaskDependency[];
  estimatedToolCalls: number;
  estimatedModelCalls: number;
  complexity: Exclude<TaskCategory, "CLARIFICATION_REQUIRED">;
  status: PlanStatus;
}

export interface SubTask {
  id: string;
  title: string;
  description: string;
  assignedRole: Exclude<PlanRole, "manager">;
  dependencies: string[];
  estimatedToolCalls: number;
  estimatedModelCalls: number;
}

export type ManagerDecision =
  | { action: "decompose"; subtasks: SubTask[] }
  | { action: "replan"; reason: string; revisedPlan: AgentPlan }
  | { action: "request-user-input"; question: string }
  | { action: "finalize"; reason: string }
  | { action: "blocked"; reason: string };

export interface ManagerState {
  classification: TaskClassification;
  managerPlan: AgentPlan;
  decision: ManagerDecision;
  replanCount: number;
  iteration: number;
  selectedModel: string;
}

export type ToolTraceStatus = "requested" | "running" | "completed" | "failed" | "denied" | "timeout";
export type ToolRole = PlanRole;
export interface ToolCallTrace {
  toolCallId: string;
  taskId: string;
  role: ToolRole;
  tool: string;
  status: ToolTraceStatus;
  startedAt: string;
  completedAt?: string;
  inputSummary: string;
  outputSummary?: string;
  evidence?: {
    summary: string;
    content: string;
  };
  errorCode?: string;
}

export interface AgentContextMemory {
  taskSummary: string;
  explicitFiles: string[];
  relevantFiles: string[];
  completedToolCalls: string[];
  activePlanStep?: string;
  importantFindings: string[];
  unresolvedQuestions: string[];
  contextVersion: number;
}

export type ProviderBudgetStatus = "available" | "limited" | "cooldown" | "unknown";
export interface ProviderBudget {
  estimatedCalls: number;
  estimatedTokens: number;
  usedCalls?: number;
  usedTokens?: number;
  queueDepth?: number;
  cooldownUntil?: string;
  remainingCalls?: number;
  remainingTokens?: number;
  status: ProviderBudgetStatus;
}

const clampConfidence = (value: number) => Math.max(0, Math.min(1, value));
const cleanTask = (task: string) => task.replace(/\s+/g, " ").trim().slice(0, 2_000);

/**
 * Classification is deliberately deterministic and uses no complex-tier model call.
 * A later manager pass may refine it, but routing must never depend on an expensive
 * model merely to decide which route to take.
 */
export function classifyTask(task: string): TaskClassification {
  const normalized = cleanTask(task);
  if (!normalized) {
    return { category: "CLARIFICATION_REQUIRED", confidence: 1, reason: "A task description is required.", estimatedToolCalls: 0, estimatedModelCalls: 0 };
  }
  const reviewOnly = /\b(review|audit|inspect|explain|understand|analy[sz]e|read[- ]only)\b/i.test(normalized);
  const ambiguous = normalized.length < 12 || /\b(something|it|that|stuff|fix this)\b/i.test(normalized);
  const complexSignals = /\b(migrate|migration|refactor|architecture|multi[- ]file|full[- ]stack|integrat|authentication|database|deploy|performance)\b/i.test(normalized);
  const moderateSignals = /\b(add|build|create|implement|update|change|debug|fix|feature|component|endpoint|api|route)\b/i.test(normalized);
  if (ambiguous && !reviewOnly) return { category: "CLARIFICATION_REQUIRED", confidence: 0.88, reason: "The requested outcome is not specific enough to plan safely.", estimatedToolCalls: 0, estimatedModelCalls: 0 };
  if (reviewOnly && !moderateSignals && !complexSignals) return { category: "REVIEW_ONLY", confidence: 0.9, reason: "The task asks for analysis without an implementation change.", estimatedToolCalls: 2, estimatedModelCalls: 1 };
  if (complexSignals) return { category: "COMPLEX", confidence: 0.78, reason: "The task suggests multiple concerns, dependencies, or architectural risk.", estimatedToolCalls: 8, estimatedModelCalls: 4 };
  if (moderateSignals || normalized.length > 100) return { category: "MODERATE", confidence: 0.76, reason: "The task describes a bounded implementation or debugging change.", estimatedToolCalls: 4, estimatedModelCalls: 2 };
  return { category: "SIMPLE", confidence: 0.8, reason: "The task is narrow enough for one focused worker pass.", estimatedToolCalls: 2, estimatedModelCalls: 1 };
}

export function validateTaskClassification(value: unknown): TaskClassification {
  if (!value || typeof value !== "object") throw new Error("Invalid task classification.");
  const candidate = value as Record<string, unknown>;
  const categories: TaskCategory[] = ["SIMPLE", "MODERATE", "COMPLEX", "REVIEW_ONLY", "CLARIFICATION_REQUIRED"];
  if (!categories.includes(candidate.category as TaskCategory)) throw new Error("Invalid task classification category.");
  if (typeof candidate.confidence !== "number" || candidate.confidence < 0 || candidate.confidence > 1) throw new Error("Invalid task classification confidence.");
  if (typeof candidate.reason !== "string" || !candidate.reason.trim()) throw new Error("Task classification reason is required.");
  if (!Number.isInteger(candidate.estimatedToolCalls) || (candidate.estimatedToolCalls as number) < 0) throw new Error("Invalid estimated tool calls.");
  if (!Number.isInteger(candidate.estimatedModelCalls) || (candidate.estimatedModelCalls as number) < 0) throw new Error("Invalid estimated model calls.");
  return {
    category: candidate.category as TaskCategory,
    confidence: clampConfidence(candidate.confidence),
    reason: candidate.reason.slice(0, 500),
    estimatedToolCalls: candidate.estimatedToolCalls as number,
    estimatedModelCalls: candidate.estimatedModelCalls as number,
  };
}

function baseSteps(taskId: string, classification: TaskClassification): PlanStep[] {
  const steps: PlanStep[] = [
    { id: `${taskId}-understand`, title: "Understand and classify task", description: "Confirm the requested outcome and route it through the cheapest safe path.", status: "COMPLETED", assignedRole: "manager", dependencies: [] },
    { id: `${taskId}-context`, title: "Inspect repository context", description: "Collect only relevant read-only repository evidence.", status: "PENDING", assignedRole: "manager", dependencies: [`${taskId}-understand`] },
  ];
  if (classification.category !== "REVIEW_ONLY") {
    steps.push({ id: `${taskId}-worker`, title: "Prepare bounded implementation proposal", description: "Select the relevant worker route and prepare a reviewable proposal without modifying files.", status: "PENDING", assignedRole: classification.category === "COMPLEX" ? "backend" : "frontend", dependencies: [`${taskId}-context`] });
  }
  steps.push({ id: `${taskId}-proposal`, title: "Prepare final proposal", description: "Present the proposed outcome for explicit user approval.", status: "PENDING", assignedRole: "manager", dependencies: [steps[steps.length - 1].id] });
  return steps.slice(0, MAX_PLAN_STEPS);
}

export function createAgentPlan(taskId: string, task: string, classification: TaskClassification): AgentPlan {
  const complexity = classification.category === "CLARIFICATION_REQUIRED" ? "SIMPLE" : classification.category;
  const steps = baseSteps(taskId, classification);
  return {
    taskId,
    goal: cleanTask(task),
    steps,
    dependencies: steps.flatMap((step) => step.dependencies.map((dependency) => ({ fromStep: dependency, toStep: step.id, reason: "Required context or prior orchestration output." }))),
    estimatedToolCalls: Math.min(30, classification.estimatedToolCalls + steps.length),
    estimatedModelCalls: Math.min(20, classification.estimatedModelCalls),
    complexity,
    status: classification.category === "CLARIFICATION_REQUIRED" ? "BLOCKED" : "ACTIVE",
  };
}

export function decomposePlan(plan: AgentPlan, task: string): SubTask[] {
  if (plan.complexity !== "COMPLEX") return [];
  const subtasks: SubTask[] = [
    { id: `${plan.taskId}-inspect`, title: "Inspect repository", description: `Find the relevant architecture and files for: ${cleanTask(task)}`, assignedRole: "backend", dependencies: [], estimatedToolCalls: 3, estimatedModelCalls: 1 },
    { id: `${plan.taskId}-implement`, title: "Prepare implementation proposal", description: "Prepare the bounded change proposal using only inspected context.", assignedRole: "frontend", dependencies: [`${plan.taskId}-inspect`], estimatedToolCalls: 3, estimatedModelCalls: 2 },
    { id: `${plan.taskId}-review-input`, title: "Prepare review context", description: "Collect the evidence needed for an independent review pass.", assignedRole: "reviewer", dependencies: [`${plan.taskId}-implement`], estimatedToolCalls: 1, estimatedModelCalls: 1 },
    { id: `${plan.taskId}-validation-plan`, title: "Define validation handoff", description: "Record bounded validation requirements for the approved proposal.", assignedRole: "validator", dependencies: [`${plan.taskId}-implement`], estimatedToolCalls: 1, estimatedModelCalls: 0 },
  ];
  return subtasks.slice(0, MAX_SUBTASKS);
}

export function selectFastModel(models: AiModel[], requestedModel: string): string {
  const approved = models.filter((model) => model.enabled);
  const fast = approved.find((model) => model.capabilities.includes("fast"));
  return fast?.id ?? approved.find((model) => model.id === requestedModel)?.id ?? approved.find((model) => model.recommended)?.id ?? requestedModel;
}

export function decideManager(state: Pick<ManagerState, "classification" | "managerPlan" | "replanCount" | "iteration">, subtasks: SubTask[]): ManagerDecision {
  if (state.iteration >= MAX_MANAGER_ITERATIONS) return { action: "blocked", reason: "The manager iteration limit was reached; no further planning actions are permitted." };
  if (state.classification.category === "CLARIFICATION_REQUIRED") return { action: "request-user-input", question: "Please describe the intended outcome and the files or area this should affect." };
  if (state.classification.category === "COMPLEX" && subtasks.length) return { action: "decompose", subtasks };
  return { action: "finalize", reason: "The bounded plan is ready for the existing approval-gated proposal flow." };
}

export function replan(state: ManagerState, reason: string): ManagerDecision {
  if (state.replanCount >= MAX_REPLANS || state.iteration >= MAX_MANAGER_ITERATIONS) {
    return { action: "blocked", reason: "The manager replan or iteration limit was reached; the system stopped safely." };
  }
  const revisedPlan: AgentPlan = { ...state.managerPlan, status: "ACTIVE", goal: `${state.managerPlan.goal} (replanned: ${reason.slice(0, 180)})` };
  return { action: "replan", reason: reason.slice(0, 500), revisedPlan };
}

export function initializeManager(taskId: string, task: string, requestedModel: string, models: AiModel[]): ManagerState {
  const classification = validateTaskClassification(classifyTask(task));
  const managerPlan = createAgentPlan(taskId || randomUUID(), task, classification);
  const subtasks = decomposePlan(managerPlan, task);
  return {
    classification,
    managerPlan,
    decision: decideManager({ classification, managerPlan, replanCount: 0, iteration: 1 }, subtasks),
    replanCount: 0,
    iteration: 1,
    selectedModel: selectFastModel(models, requestedModel),
  };
}

export function getReadySteps(plan: AgentPlan): PlanStep[] {
  return plan.steps.filter((step) => step.status === "PENDING" && step.dependencies.every((dependency) => plan.steps.find((candidate) => candidate.id === dependency)?.status === "COMPLETED"));
}