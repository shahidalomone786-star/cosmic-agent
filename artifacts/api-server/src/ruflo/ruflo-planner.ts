import type { AiProvider } from "../ai/ai-provider";
import { fitContext } from "../ai/context-budget";
import type { RepositoryRef } from "../repository/github-provider";
import { selectRufloSpecializedAgents, type RufloSpecializedAgentRole } from "./ruflo-specialized-agents";

export const MAX_RUFLO_PLAN_STEPS = 6;
export const MAX_RUFLO_OBSERVATIONS_IN_PROMPT = 8;
export const MAX_RUFLO_PROMPT_CHARS = 28_000;

export type RufloAction =
  | "inspect_repository"
  | "search_repository"
  | "read_file"
  | "prepare_proposal";

export type RufloPlanStepStatus = "pending" | "active" | "completed";

export type RufloPlanStep = {
  id: string;
  title: string;
  description: string;
  status: RufloPlanStepStatus;
};

export type RufloPlan = {
  goal: string;
  steps: RufloPlanStep[];
  specializedAgents?: RufloSpecializedAgentRole[];
};

export type RufloPlannerObservation = {
  iteration: number;
  tool: string;
  status: "completed" | "failed";
  summary: string;
  result?: unknown;
  error?: string;
};

export type RufloPlannerInput = {
  provider: AiProvider;
  model: string;
  task: string;
  repository?: RepositoryRef;
  workspace?: { userId: string; projectId: string };
  selectedFiles: string[];
  context: string;
  memoryContext?: string;
};

export type RufloDecisionInput = RufloPlannerInput & {
  plan: RufloPlan;
  observations: RufloPlannerObservation[];
  iteration: number;
};

export type RufloDecision = {
  action: RufloAction;
  reasoning: string;
  input?: {
    query?: string;
    path?: string;
  };
};

export interface RufloPlanner {
  createPlan(input: RufloPlannerInput): Promise<RufloPlan>;
  decide(input: RufloDecisionInput): Promise<RufloDecision>;
}

export class RufloPlannerError extends Error {
  constructor(
    readonly code: "invalid_response" | "empty_response" | "provider_failure",
    message: string,
  ) {
    super(message);
    this.name = "RufloPlannerError";
  }
}

const ACTIONS: readonly RufloAction[] = [
  "inspect_repository",
  "search_repository",
  "read_file",
  "prepare_proposal",
];

/**
 * The model is used for planning and choosing the next bounded action only.
 * It never receives a tool implementation and never executes a repository
 * operation itself.
 */
export class ModelRufloPlanner implements RufloPlanner {
  async createPlan(input: RufloPlannerInput): Promise<RufloPlan> {
    const response = await input.provider.chat({
      model: input.model,
      role: "manager",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "You are the Ruflo planner.",
            "Decompose the user's repository task into a small, ordered, read-first plan.",
            `Return JSON only in this shape: {"steps":[{"id":"string","title":"string","description":"string"}],"specializedAgents":["test_generator|documentation|git_intelligence|browser"]}.`,
            `Use at most ${MAX_RUFLO_PLAN_STEPS} steps.`,
            "Select only the minimum specialized agents required by the user's task. Use test_generator for coverage, documentation for docs, git_intelligence for read-only Git analysis, and browser only for bounded rendered-page checks.",
            "Do not propose writes, apply, commit, push, swarm, memory, or parallel work.",
            "The runtime will execute only bounded read tools and will ask you for one next action at a time.",
          ].join("\n"),
        },
        {
          role: "user",
          content: buildPlannerContext(input, "Create the bounded task plan."),
        },
      ],
    });

    return parsePlan(response.content, input.task);
  }

  async decide(input: RufloDecisionInput): Promise<RufloDecision> {
    const response = await input.provider.chat({
      model: input.model,
      role: "manager",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "You are the Ruflo decision planner.",
            "Choose exactly one next action for the server-side continuation loop.",
            `Return JSON only in this shape: {"action":"inspect_repository|search_repository|read_file|prepare_proposal","reasoning":"string","input":{"query":"optional","path":"optional"}}.`,
            "inspect_repository is the first action when repository context is not yet inspected.",
            "Use search_repository to locate symbols or files, and read_file to inspect a concrete relevant file.",
            "Choose prepare_proposal only after useful repository evidence has been observed.",
            "Never request a write, apply, commit, push, parallel, swarm, or memory action.",
            "Do not invent file paths. Use selected files or paths present in observations.",
          ].join("\n"),
        },
        {
          role: "user",
          content: buildPlannerContext(input, `Choose the next action for iteration ${input.iteration}.`),
        },
      ],
    });

    return parseDecision(response.content);
  }
}

function buildPlannerContext(
  input: RufloPlannerInput | RufloDecisionInput,
  instruction: string,
): string {
  const observations = "observations" in input
    ? input.observations.slice(-MAX_RUFLO_OBSERVATIONS_IN_PROMPT).map((observation) => ({
        iteration: observation.iteration,
        tool: observation.tool,
        status: observation.status,
        summary: observation.summary,
        result: observation.result,
        error: observation.error,
      }))
    : [];
  const bounded = fitContext([
    { key: "task", text: `USER TASK\n${input.task}`, relevance: 100, explicit: true },
    { key: "target", text: `TARGET\n${targetLabel(input)}`, relevance: 90, explicit: true },
    { key: "selected-files", text: `SELECTED FILES\n${input.selectedFiles.join("\n") || "(none yet)"}`, relevance: 80, explicit: true },
    { key: "context", text: `OBSERVED CONTEXT\n${input.context || "(empty)"}`, relevance: 70 },
    {
      key: "memory",
      text: input.memoryContext
        ? input.memoryContext
        : "HISTORICAL RUFLO MEMORY\n(none available)",
      relevance: 35,
    },
    { key: "plan", text: "plan" in input ? `PLAN\n${JSON.stringify(input.plan)}` : "", relevance: 60 },
    { key: "observations", text: `TOOL OBSERVATIONS\n${JSON.stringify(observations)}`, relevance: 60 },
  ], MAX_RUFLO_PROMPT_CHARS);

  return `${instruction}\n\n${bounded.text}`.slice(0, MAX_RUFLO_PROMPT_CHARS);
}

function targetLabel(input: RufloPlannerInput): string {
  if (input.repository) return `${input.repository.owner}/${input.repository.name}#${input.repository.branch}`;
  if (input.workspace) return `workspace:${input.workspace.projectId}`;
  return "no connected repository or workspace";
}

function parsePlan(content: string, task: string): RufloPlan {
  const parsed = parseJson(content);
  const candidate = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  const rawSteps = Array.isArray(candidate?.steps) ? candidate.steps : [];
  if (!rawSteps.length) {
    throw new RufloPlannerError("invalid_response", "The Ruflo planner returned no bounded task steps.");
  }

  const steps = rawSteps.slice(0, MAX_RUFLO_PLAN_STEPS).map((raw, index): RufloPlanStep => {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return {
      id: stringValue(value.id, `ruflo-step-${index + 1}`).slice(0, 80),
      title: stringValue(value.title, `Bounded task step ${index + 1}`).slice(0, 160),
      description: stringValue(value.description, "Inspect only the evidence needed for the requested task.").slice(0, 500),
      status: index === 0 ? "active" : "pending",
    };
  });

  const requestedAgents = Array.isArray(candidate?.specializedAgents)
    ? candidate.specializedAgents.filter((value): value is RufloSpecializedAgentRole =>
      value === "test_generator" || value === "documentation" || value === "git_intelligence" || value === "browser",
    )
    : [];
  const selectedAgents = [...new Set([...selectRufloSpecializedAgents(task), ...requestedAgents])].slice(0, 4);
  return { goal: task.slice(0, 2_000), steps, specializedAgents: selectedAgents };
}

function parseDecision(content: string): RufloDecision {
  const parsed = parseJson(content);
  if (!parsed || typeof parsed !== "object") {
    throw new RufloPlannerError("invalid_response", "The Ruflo planner returned an invalid next-action response.");
  }
  const value = parsed as Record<string, unknown>;
  if (!ACTIONS.includes(value.action as RufloAction)) {
    throw new RufloPlannerError("invalid_response", "The Ruflo planner requested an unsupported action.");
  }
  const rawInput = value.input && typeof value.input === "object" ? value.input as Record<string, unknown> : {};
  return {
    action: value.action as RufloAction,
    reasoning: stringValue(value.reasoning, "The bounded planner selected the next safe inspection action.").slice(0, 500),
    input: {
      ...(typeof rawInput.query === "string" ? { query: rawInput.query.slice(0, 240) } : {}),
      ...(typeof rawInput.path === "string" ? { path: rawInput.path.slice(0, 500) } : {}),
    },
  };
}

function parseJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) throw new RufloPlannerError("empty_response", "The Ruflo planner returned an empty response.");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new RufloPlannerError("invalid_response", "The Ruflo planner returned malformed JSON.");
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}