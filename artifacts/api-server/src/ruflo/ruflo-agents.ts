import { randomUUID } from "node:crypto";
import type { ChangeProposal } from "../ai/change-proposal";
import type { RufloSession } from "./ruflo-runtime";
import type { RufloPlan } from "./ruflo-planner";

export type RufloAgentRole = "planner" | "coder" | "reviewer" | "validator" | "fixer";
export type RufloAgentStatus = "completed" | "failed";

export type RufloAgentLimits = {
  maxAgentsPerSession: number;
  maxRetries: number;
  maxTotalIterations: number;
};

export const DEFAULT_RUFLO_AGENT_LIMITS: RufloAgentLimits = {
  maxAgentsPerSession: 5,
  maxRetries: 1,
  maxTotalIterations: 10,
};

export type RufloAgentExecution<T> = {
  executionId: string;
  role: RufloAgentRole;
  status: RufloAgentStatus;
  iteration: number;
  attempts: number;
  input: {
    sourceExecutionIds: string[];
    summary: string;
  };
  output?: T;
  error?: string;
  startedAt: string;
  completedAt: string;
};

export type RufloPlannerOutput = {
  delegation: {
    role: "coder";
    task: string;
    selectedFiles: string[];
    context: string;
    plan: RufloPlan;
  };
};

export type RufloProposalOutput = {
  proposal: ChangeProposal;
  sourceRole: "coder" | "fixer";
  sourceExecutionId: string;
};

export type RufloReviewOutput = {
  proposalId: string;
  proposalAgentExecutionId?: string;
  review: RufloAgentReview;
};

export type RufloValidationOutput = {
  proposalId: string;
  appliedResult: unknown;
  reviewerExecutionId?: string;
  validation: RufloAgentValidation;
};

export type RufloFixOutput = RufloProposalOutput & {
  proposal: ChangeProposal;
  validationExecutionId: string;
  attempt: number;
};

export type RufloAgentReview = {
  status: "pass" | "fail";
  summary: string;
};

export type RufloAgentValidation = {
  status: "pass" | "fail" | "not-verified";
  summary: string;
};

export class RufloAgentLimitError extends Error {
  constructor(readonly code: "agent_limit" | "iteration_limit", message: string) {
    super(message);
    this.name = "RufloAgentLimitError";
  }
}

export class RufloSequentialCoordinator {
  private readonly limits: RufloAgentLimits;
  private readonly usedRoles: Set<RufloAgentRole>;
  private totalIterations: number;
  private readonly executions: RufloAgentExecution<unknown>[];
  private readonly onExecution?: (execution: RufloAgentExecution<unknown>) => void;

  constructor(input: {
    limits?: Partial<RufloAgentLimits>;
    existingExecutions?: readonly RufloAgentExecution<unknown>[];
    onExecution?: (execution: RufloAgentExecution<unknown>) => void;
  } = {}) {
    this.limits = normalizeAgentLimits(input.limits);
    this.executions = [...(input.existingExecutions ?? [])];
    this.usedRoles = new Set(this.executions.map((execution) => execution.role));
    this.totalIterations = this.executions.reduce((total, execution) => total + execution.attempts, 0);
    this.onExecution = input.onExecution;
  }

  get snapshot(): RufloAgentExecution<unknown>[] {
    return [...this.executions];
  }

  async run<T>(
    role: RufloAgentRole,
    sourceExecutionIds: readonly string[],
    inputSummary: string,
    operation: () => Promise<T>,
  ): Promise<RufloAgentExecution<T>> {
    if (!this.usedRoles.has(role) && this.usedRoles.size >= this.limits.maxAgentsPerSession) {
      throw new RufloAgentLimitError(
        "agent_limit",
        `Ruflo stopped because the agent limit of ${this.limits.maxAgentsPerSession} was reached.`,
      );
    }

    const executionId = randomUUID();
    const startedAt = new Date().toISOString();
    let lastError: unknown = new Error(`${role} failed.`);
    let attempts = 0;
    this.usedRoles.add(role);

    for (let retry = 0; retry <= this.limits.maxRetries; retry += 1) {
      if (this.totalIterations >= this.limits.maxTotalIterations) {
        throw new RufloAgentLimitError(
          "iteration_limit",
          `Ruflo stopped because the total agent iteration limit of ${this.limits.maxTotalIterations} was reached.`,
        );
      }
      this.totalIterations += 1;
      attempts += 1;
      try {
        const output = await operation();
        const execution: RufloAgentExecution<T> = {
          executionId,
          role,
          status: "completed",
          iteration: this.totalIterations,
          attempts,
          input: { sourceExecutionIds: [...sourceExecutionIds], summary: inputSummary.slice(0, 1_000) },
          output,
          startedAt,
          completedAt: new Date().toISOString(),
        };
        this.record(execution);
        return execution;
      } catch (error) {
        lastError = error;
        if (retry >= this.limits.maxRetries) break;
      }
    }

    const execution: RufloAgentExecution<T> = {
      executionId,
      role,
      status: "failed",
      iteration: this.totalIterations,
      attempts,
      input: { sourceExecutionIds: [...sourceExecutionIds], summary: inputSummary.slice(0, 1_000) },
      error: errorMessage(lastError),
      startedAt,
      completedAt: new Date().toISOString(),
    };
    this.record(execution);
    return execution;
  }

  private record(execution: RufloAgentExecution<unknown>): void {
    this.executions.push(execution);
    this.onExecution?.(execution);
  }
}

export class RufloPlannerAgent {
  async run(session: RufloSession): Promise<RufloPlannerOutput> {
    const selectedFiles = [...new Set([
      ...session.selectedFiles,
      ...session.discoveredFiles,
    ])].slice(0, 20);
    return {
      delegation: {
        role: "coder",
        task: session.task,
        selectedFiles,
        context: session.context.slice(0, 32_000),
        plan: session.plan,
      },
    };
  }
}

export class RufloCoderAgent {
  async run(input: {
    plannerExecution: RufloAgentExecution<RufloPlannerOutput>;
    createProposal: (delegation: RufloPlannerOutput["delegation"]) => Promise<ChangeProposal>;
  }): Promise<RufloProposalOutput> {
    assertCompleted(input.plannerExecution, "Planner");
    const delegation = input.plannerExecution.output?.delegation;
    if (!delegation || delegation.role !== "coder") {
      throw new Error("The Coder requires a completed Planner delegation.");
    }
    const proposal = await input.createProposal(delegation);
    return {
      proposal,
      sourceRole: "coder",
      sourceExecutionId: input.plannerExecution.executionId,
    };
  }
}

export class RufloReviewerAgent {
  async run(input: {
    proposalAgent?: RufloAgentExecution<RufloProposalOutput>;
    proposal: ChangeProposal;
    boundedPaths: readonly string[];
    review: (proposal: ChangeProposal, proposalAgent?: RufloAgentExecution<RufloProposalOutput>) => Promise<RufloAgentReview>;
  }): Promise<RufloReviewOutput> {
    if (input.proposalAgent) assertCompleted(input.proposalAgent, "Coder or Fixer");
    const review = await input.review(input.proposal, input.proposalAgent);
    return {
      proposalId: input.proposal.proposalId,
      proposalAgentExecutionId: input.proposalAgent?.executionId,
      review,
    };
  }
}

export class RufloValidatorAgent {
  async run(input: {
    reviewerExecution?: RufloAgentExecution<RufloReviewOutput>;
    proposal: ChangeProposal;
    appliedResult: unknown;
    validate: (
      proposal: ChangeProposal,
      appliedResult: unknown,
      reviewerExecution?: RufloAgentExecution<RufloReviewOutput>,
    ) => Promise<RufloAgentValidation>;
  }): Promise<RufloValidationOutput> {
    if (input.reviewerExecution) assertCompleted(input.reviewerExecution, "Reviewer");
    const validation = await input.validate(input.proposal, input.appliedResult, input.reviewerExecution);
    return {
      proposalId: input.proposal.proposalId,
      appliedResult: input.appliedResult,
      reviewerExecutionId: input.reviewerExecution?.executionId,
      validation,
    };
  }
}

export class RufloFixerAgent {
  async run(input: {
    validationExecution: RufloAgentExecution<RufloValidationOutput>;
    attempt: number;
    createFixProposal: (diagnosis: string, attempt: number, validationOutput: RufloValidationOutput) => Promise<ChangeProposal>;
  }): Promise<RufloFixOutput> {
    assertCompleted(input.validationExecution, "Validator");
    const validation = input.validationExecution.output;
    if (!validation || validation.validation.status === "pass") {
      throw new Error("The Fixer can only run after a validation failure.");
    }
    const proposal = await input.createFixProposal(
      validation.validation.summary.slice(0, 4_000),
      input.attempt,
      validation,
    );
    return {
      proposal,
      sourceRole: "fixer",
      sourceExecutionId: input.validationExecution.executionId,
      validationExecutionId: input.validationExecution.executionId,
      attempt: input.attempt,
    };
  }
}

export async function runRufloPreparationAgents(input: {
  session: RufloSession;
  limits?: Partial<RufloAgentLimits>;
  existingExecutions?: readonly RufloAgentExecution<unknown>[];
  onExecution?: (execution: RufloAgentExecution<unknown>) => void;
  createProposal: (delegation: RufloPlannerOutput["delegation"]) => Promise<ChangeProposal>;
}): Promise<{
  planner: RufloAgentExecution<RufloPlannerOutput>;
  coder: RufloAgentExecution<RufloProposalOutput>;
  executions: RufloAgentExecution<unknown>[];
}> {
  const coordinator = new RufloSequentialCoordinator({
    limits: input.limits,
    existingExecutions: input.existingExecutions,
    onExecution: input.onExecution,
  });
  const planner = await coordinator.run(
    "planner",
    [],
    "Delegate the inspected task to the Coder.",
    () => new RufloPlannerAgent().run(input.session),
  );
  if (planner.status !== "completed" || !planner.output) {
    throw new Error(planner.error ?? "Planner did not complete a Coder delegation.");
  }
  const coder = await coordinator.run(
    "coder",
    [planner.executionId],
    "Consume the Planner delegation and create a proposal through the existing proposal boundary.",
    () => new RufloCoderAgent().run({
      plannerExecution: planner,
      createProposal: input.createProposal,
    }),
  );
  if (coder.status !== "completed" || !coder.output) {
    throw new Error(coder.error ?? "Coder did not create a proposal.");
  }
  return { planner, coder, executions: coordinator.snapshot };
}

function normalizeAgentLimits(input: Partial<RufloAgentLimits> | undefined): RufloAgentLimits {
  return {
    maxAgentsPerSession: positiveLimit(input?.maxAgentsPerSession, DEFAULT_RUFLO_AGENT_LIMITS.maxAgentsPerSession, 1, 5),
    maxRetries: positiveLimit(input?.maxRetries, DEFAULT_RUFLO_AGENT_LIMITS.maxRetries, 0, 5),
    maxTotalIterations: positiveLimit(input?.maxTotalIterations, DEFAULT_RUFLO_AGENT_LIMITS.maxTotalIterations, 1, 32),
  };
}

function positiveLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value as number))) : fallback;
}

function assertCompleted<T>(execution: RufloAgentExecution<T>, role: string): asserts execution is RufloAgentExecution<T> & { output: T } {
  if (execution.status !== "completed" || !execution.output) {
    throw new Error(`${role} did not produce a usable structured result.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}