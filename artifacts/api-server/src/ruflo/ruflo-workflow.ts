import type { ChangeProposal } from "../ai/change-proposal";
import { reviewRufloProposal } from "./ruflo-proposal";
import {
  RufloFixerAgent,
  RufloReviewerAgent,
  RufloSequentialCoordinator,
  RufloValidatorAgent,
  type RufloAgentExecution,
  type RufloAgentLimits,
  type RufloProposalOutput,
  type RufloReviewOutput,
  type RufloValidationOutput,
} from "./ruflo-agents";

export const MAX_RUFLO_RECOVERY_ATTEMPTS = 3;

export type RufloWorkflowPhase =
  | "reviewing"
  | "validating"
  | "fixing"
  | "waiting_approval"
  | "completed"
  | "failed";

export type RufloWorkflowReview = {
  status: "pass" | "fail";
  summary: string;
};

export type RufloWorkflowValidation = {
  status: "pass" | "fail" | "not-verified";
  summary: string;
};

export type RufloWorkflowResult = {
  status: "completed" | "waiting_approval" | "failed";
  phase: Extract<RufloWorkflowPhase, "completed" | "waiting_approval" | "failed">;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  approvalRequired: boolean;
  approvalRisk?: ChangeProposal["risk"];
  proposal?: ChangeProposal;
  review?: RufloWorkflowReview;
  validation?: RufloWorkflowValidation;
  agentExecutions: RufloAgentExecution<unknown>[];
  proposalAgent?: RufloAgentExecution<RufloProposalOutput>;
  message: string;
};

export type RufloWorkflowInput = {
  proposal: ChangeProposal;
  boundedPaths: readonly string[];
  recoveryAttempts: number;
  onPhase?: (phase: RufloWorkflowPhase) => void;
  reviewer?: (proposal: ChangeProposal, proposalAgent?: RufloAgentExecution<RufloProposalOutput>) => Promise<RufloWorkflowReview>;
  validator: (proposal: ChangeProposal, appliedResult: unknown, reviewerExecution?: RufloAgentExecution<RufloReviewOutput>) => Promise<RufloWorkflowValidation>;
  rollback: () => Promise<void>;
  createFixProposal: (diagnosis: string, attempt: number, validationOutput?: RufloValidationOutput) => Promise<ChangeProposal>;
  appliedResult?: unknown;
  proposalAgent?: RufloAgentExecution<RufloProposalOutput>;
  agentExecutions?: readonly RufloAgentExecution<unknown>[];
  agentLimits?: Partial<RufloAgentLimits>;
  onAgent?: (execution: RufloAgentExecution<unknown>) => void;
};

/**
 * Coordinates the post-approval Ruflo lifecycle. Applying is deliberately
 * outside this function: the caller must pass through the existing approval
 * gate and patch executor first.
 */
export async function runRufloPostApproval(input: RufloWorkflowInput): Promise<RufloWorkflowResult> {
  const coordinator = new RufloSequentialCoordinator({
    limits: input.agentLimits,
    existingExecutions: input.agentExecutions,
    onExecution: input.onAgent,
  });
  input.onPhase?.("reviewing");
  const reviewerExecution = await coordinator.run(
    "reviewer",
    input.proposalAgent ? [input.proposalAgent.executionId] : [],
    "Consume the completed Coder or Fixer proposal and review its bounded file operations.",
    () => new RufloReviewerAgent().run({
      proposalAgent: input.proposalAgent,
      proposal: input.proposal,
      boundedPaths: input.boundedPaths,
      review: async (proposal, proposalAgent) => {
        try {
          return await (input.reviewer ?? ((candidate) => defaultReviewer(candidate, input.boundedPaths)))(proposal, proposalAgent);
        } catch (error) {
          return { status: "fail", summary: `Reviewer could not complete safely. ${errorMessage(error)}` };
        }
      },
    }),
  );
  const review = reviewerExecution.output?.review ?? {
    status: "fail" as const,
    summary: reviewerExecution.error ?? "Reviewer did not produce a structured result.",
  };
  if (review.status !== "pass") {
    return stopAfterReviewFailure(input, coordinator, reviewerExecution, review);
  }

  input.onPhase?.("validating");
  const validatorExecution = await coordinator.run(
    "validator",
    [reviewerExecution.executionId],
    "Consume the Reviewer result and the server result from the applied proposal.",
    () => new RufloValidatorAgent().run({
      reviewerExecution,
      proposal: input.proposal,
      appliedResult: input.appliedResult,
      validate: async (proposal, appliedResult, reviewer) => {
        try {
          return await input.validator(proposal, appliedResult, reviewer);
        } catch (error) {
          return { status: "not-verified", summary: `Validator could not complete safely. ${errorMessage(error)}` };
        }
      },
    }),
  );
  const validation = validatorExecution.output?.validation ?? {
    status: "not-verified" as const,
    summary: validatorExecution.error ?? "Validator did not produce a structured result.",
  };
  if (validation.status !== "pass") {
    return recover(input, coordinator, validatorExecution, validation.summary, validation, review, reviewerExecution);
  }

  input.onPhase?.("completed");
  return {
    status: "completed",
    phase: "completed",
    recoveryAttempts: input.recoveryAttempts,
    maxRecoveryAttempts: MAX_RUFLO_RECOVERY_ATTEMPTS,
    approvalRequired: false,
    review,
    validation,
    agentExecutions: coordinator.snapshot,
    proposalAgent: input.proposalAgent,
    message: "Reviewer approved the applied change and validation passed.",
  };
}

async function recover(
  input: RufloWorkflowInput,
  coordinator: RufloSequentialCoordinator,
  validatorExecution: RufloAgentExecution<RufloValidationOutput>,
  diagnosis: string,
  validation?: RufloWorkflowValidation,
  review?: RufloWorkflowReview,
  reviewerExecution?: RufloAgentExecution<RufloReviewOutput>,
): Promise<RufloWorkflowResult> {
  try {
    await input.rollback();
  } catch (error) {
    input.onPhase?.("failed");
    return failedResult(
      input,
      coordinator,
      validation,
      review,
      input.proposalAgent,
      `The applied change could not be rolled back safely. ${errorMessage(error)}`,
    );
  }

  if (input.recoveryAttempts >= MAX_RUFLO_RECOVERY_ATTEMPTS) {
    input.onPhase?.("failed");
    return failedResult(
      input,
      coordinator,
      validation,
      review,
      input.proposalAgent,
      `Validation failed after ${MAX_RUFLO_RECOVERY_ATTEMPTS} recovery attempts. Ruflo stopped safely.`,
    );
  }

  const attempt = input.recoveryAttempts + 1;
  input.onPhase?.("fixing");
  try {
    const fixerExecution = await coordinator.run(
      "fixer",
      [validatorExecution.executionId],
      "Consume the failed Validator result and create a new proposal; never apply it automatically.",
      () => new RufloFixerAgent().run({
        validationExecution: validatorExecution,
        attempt,
        createFixProposal: input.createFixProposal,
      }),
    );
    if (fixerExecution.status !== "completed" || !fixerExecution.output) {
      input.onPhase?.("failed");
      return failedResult(
        input,
        coordinator,
        validation,
        review,
        input.proposalAgent,
        fixerExecution.error ?? "Fixer did not produce a structured proposal.",
      );
    }
    const proposal = fixerExecution.output.proposal;
    input.onPhase?.("waiting_approval");
    return {
      status: "waiting_approval",
      phase: "waiting_approval",
      recoveryAttempts: attempt,
      maxRecoveryAttempts: MAX_RUFLO_RECOVERY_ATTEMPTS,
      approvalRequired: true,
      approvalRisk: proposal.risk,
      proposal,
      review,
      validation,
      agentExecutions: coordinator.snapshot,
      proposalAgent: fixerExecution,
      message: `Validation failed safely. Fix proposal ${attempt} of ${MAX_RUFLO_RECOVERY_ATTEMPTS} is ready and requires explicit ${proposal.risk.toLowerCase()}-risk approval.`,
    };
  } catch (error) {
    input.onPhase?.("failed");
    return failedResult(
      input,
      coordinator,
      validation,
      review,
      input.proposalAgent,
      `Ruflo could not create a bounded fix proposal. ${errorMessage(error)}`,
    );
  }
}

async function stopAfterReviewFailure(
  input: RufloWorkflowInput,
  coordinator: RufloSequentialCoordinator,
  reviewerExecution: RufloAgentExecution<RufloReviewOutput>,
  review: RufloWorkflowReview,
): Promise<RufloWorkflowResult> {
  try {
    await input.rollback();
  } catch (error) {
    input.onPhase?.("failed");
    return failedResult(
      input,
      coordinator,
      undefined,
      review,
      input.proposalAgent,
      `The applied change could not be rolled back safely after review failure. ${errorMessage(error)}`,
    );
  }
  input.onPhase?.("failed");
  return failedResult(
    input,
    coordinator,
    undefined,
    review,
    input.proposalAgent,
    reviewerExecution.error
      ? `Reviewer failed safely. ${reviewerExecution.error}`
      : `Reviewer rejected the applied change. ${review.summary}`,
  );
}

function failedResult(
  input: RufloWorkflowInput,
  coordinator: RufloSequentialCoordinator,
  validation: RufloWorkflowValidation | undefined,
  review: RufloWorkflowReview | undefined,
  proposalAgent: RufloAgentExecution<RufloProposalOutput> | undefined,
  message: string,
): RufloWorkflowResult {
  return {
    status: "failed",
    phase: "failed",
    recoveryAttempts: input.recoveryAttempts,
    maxRecoveryAttempts: MAX_RUFLO_RECOVERY_ATTEMPTS,
    approvalRequired: false,
    review,
    validation,
    agentExecutions: coordinator.snapshot,
    proposalAgent,
    message,
  };
}

async function defaultReviewer(proposal: ChangeProposal, boundedPaths: readonly string[]): Promise<RufloWorkflowReview> {
  try {
    reviewRufloProposal(proposal, boundedPaths);
    return { status: "pass", summary: "The applied proposal remains within the reviewed file and safety boundaries." };
  } catch (error) {
    return { status: "fail", summary: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The bounded operation failed.";
}

export {
  RufloSequentialCoordinator,
  RufloReviewerAgent,
  RufloValidatorAgent,
  runRufloPreparationAgents,
} from "./ruflo-agents";