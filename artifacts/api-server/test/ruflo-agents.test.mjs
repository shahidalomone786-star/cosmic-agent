import test from "node:test";
import assert from "node:assert/strict";
import {
  RufloSequentialCoordinator,
  RufloReviewerAgent,
  RufloValidatorAgent,
  runRufloPreparationAgents,
  runRufloPostApproval,
} from "../test-dist/ruflo-workflow.cjs";

const proposal = (id = "proposal-1") => ({
  proposalId: id,
  status: "proposal",
  summary: "Bounded change",
  explanation: "A focused change",
  risk: "LOW",
  affectedFiles: ["src/example.ts"],
  addedLines: 1,
  removedLines: 1,
  plan: ["Inspect", "Apply"],
  validationPlan: ["Typecheck", "Build"],
  files: [{
    path: "src/example.ts",
    operation: "edit",
    language: "typescript",
    originalCode: "export const value = 1;\n",
    proposedCode: "export const value = 2;\n",
    diff: "-export const value = 1;\n+export const value = 2;\n",
    explanation: "Update the value",
    addedLines: 1,
    removedLines: 1,
  }],
});

const session = {
  id: "session-1",
  task: "update the example",
  status: "proposal_ready",
  plan: {
    goal: "update the example",
    steps: [{ id: "step-1", title: "Inspect", description: "Inspect", status: "active" }],
  },
  iteration: 1,
  toolCalls: 1,
  retries: 0,
  selectedFiles: ["src/example.ts"],
  discoveredFiles: ["src/example.ts"],
  context: "{\"path\":\"src/example.ts\"}",
  observations: [],
  events: [],
  proposalReady: true,
  providerAttempts: [],
  agentExecutions: [],
  agentLimits: { maxAgentsPerSession: 5, maxRetries: 1, maxTotalIterations: 10 },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

test("Planner delegates a structured handoff that the Coder consumes", async () => {
  let receivedDelegation;
  const prepared = await runRufloPreparationAgents({
    session,
    createProposal: async (delegation) => {
      receivedDelegation = delegation;
      return proposal();
    },
  });

  assert.equal(prepared.planner.role, "planner");
  assert.equal(prepared.planner.status, "completed");
  assert.equal(prepared.planner.output.delegation.role, "coder");
  assert.equal(prepared.coder.role, "coder");
  assert.equal(prepared.coder.input.sourceExecutionIds[0], prepared.planner.executionId);
  assert.equal(receivedDelegation, prepared.planner.output.delegation);
  assert.equal(prepared.coder.output.proposal.proposalId, "proposal-1");
});

test("Reviewer consumes the Coder proposal and Validator consumes the applied result", async () => {
  const coder = {
    executionId: "coder-1",
    role: "coder",
    status: "completed",
    iteration: 1,
    attempts: 1,
    input: { sourceExecutionIds: ["planner-1"], summary: "coder" },
    output: { proposal: proposal(), sourceRole: "coder", sourceExecutionId: "planner-1" },
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
  };
  const appliedResult = { status: "applied", proposalId: "proposal-1", files: ["src/example.ts"] };
  let reviewerInput;
  let validatorInput;
  const result = await runRufloPostApproval({
    proposal: proposal(),
    proposalAgent: coder,
    agentExecutions: [coder],
    appliedResult,
    recoveryAttempts: 0,
    reviewer: async (currentProposal, proposalAgent) => {
      reviewerInput = { currentProposal, proposalAgent };
      return { status: "pass", summary: "Reviewer passed." };
    },
    validator: async (currentProposal, currentAppliedResult, reviewerExecution) => {
      validatorInput = { currentProposal, currentAppliedResult, reviewerExecution };
      return { status: "pass", summary: "Validator passed." };
    },
    rollback: async () => {},
    createFixProposal: async () => proposal("unexpected-fix"),
  });

  assert.equal(result.status, "completed");
  assert.equal(reviewerInput.currentProposal.proposalId, "proposal-1");
  assert.equal(reviewerInput.proposalAgent.executionId, coder.executionId);
  assert.equal(validatorInput.currentAppliedResult, appliedResult);
  assert.equal(validatorInput.reviewerExecution.role, "reviewer");
  assert.deepEqual(result.agentExecutions.map((execution) => execution.role), ["coder", "reviewer", "validator"]);
});

test("Fixer is invoked only after a validation failure", async () => {
  let fixCalls = 0;
  const result = await runRufloPostApproval({
    proposal: proposal(),
    proposalAgent: {
      executionId: "coder-1",
      role: "coder",
      status: "completed",
      iteration: 1,
      attempts: 1,
      input: { sourceExecutionIds: ["planner-1"], summary: "coder" },
      output: { proposal: proposal(), sourceRole: "coder", sourceExecutionId: "planner-1" },
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
    },
    appliedResult: { status: "applied" },
    recoveryAttempts: 0,
    reviewer: async () => ({ status: "pass", summary: "Reviewer passed." }),
    validator: async () => ({ status: "fail", summary: "Typecheck failed." }),
    rollback: async () => {},
    createFixProposal: async (diagnosis, attempt, validationOutput) => {
      fixCalls += 1;
      assert.equal(diagnosis, "Typecheck failed.");
      assert.equal(attempt, 1);
      assert.equal(validationOutput.validation.status, "fail");
      return proposal("fix-1");
    },
  });

  assert.equal(result.status, "waiting_approval");
  assert.equal(fixCalls, 1);
  assert.equal(result.proposalAgent.role, "fixer");
  assert.equal(result.proposalAgent.input.sourceExecutionIds[0], result.agentExecutions.find((execution) => execution.role === "validator").executionId);
});

test("Reviewer failure stops safely without invoking the Fixer", async () => {
  let fixCalls = 0;
  const result = await runRufloPostApproval({
    proposal: proposal(),
    appliedResult: { status: "applied" },
    recoveryAttempts: 0,
    reviewer: async () => ({ status: "fail", summary: "Unsafe scope." }),
    validator: async () => ({ status: "pass", summary: "Should not run." }),
    rollback: async () => {},
    createFixProposal: async () => {
      fixCalls += 1;
      return proposal("unexpected-fix");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.phase, "failed");
  assert.equal(fixCalls, 0);
  assert.deepEqual(result.agentExecutions.map((execution) => execution.role), ["reviewer"]);
});

test("Sequential coordinator stops after the bounded total iterations", async () => {
  const coordinator = new RufloSequentialCoordinator({
    limits: { maxTotalIterations: 2, maxRetries: 1 },
  });
  const first = await coordinator.run("planner", [], "first", async () => "done");
  const second = await coordinator.run("coder", [first.executionId], "second", async () => "done");

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  await assert.rejects(
    coordinator.run("reviewer", [second.executionId], "third", async () => "never"),
    /total agent iteration limit/,
  );
  assert.equal(coordinator.snapshot.length, 2);
});

test("Agent classes preserve structured outputs between explicit stages", async () => {
  const coder = {
    executionId: "coder-1",
    role: "coder",
    status: "completed",
    iteration: 1,
    attempts: 1,
    input: { sourceExecutionIds: ["planner-1"], summary: "coder" },
    output: { proposal: proposal(), sourceRole: "coder", sourceExecutionId: "planner-1" },
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
  };
  const reviewer = await new RufloReviewerAgent().run({
    proposalAgent: coder,
    proposal: coder.output.proposal,
    boundedPaths: ["src/example.ts"],
    review: async (currentProposal, proposalAgent) => ({
      status: currentProposal === proposalAgent.output.proposal ? "pass" : "fail",
      summary: "structured",
    }),
  });
  const reviewerExecution = {
    executionId: "reviewer-1",
    role: "reviewer",
    status: "completed",
    iteration: 2,
    attempts: 1,
    input: { sourceExecutionIds: [coder.executionId], summary: "reviewer" },
    output: reviewer,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
  };
  const appliedResult = { status: "applied" };
  const validator = await new RufloValidatorAgent().run({
    reviewerExecution,
    proposal: coder.output.proposal,
    appliedResult,
    validate: async (currentProposal, currentAppliedResult, currentReviewer) => ({
      status: currentProposal === coder.output.proposal && currentAppliedResult === appliedResult && currentReviewer === reviewerExecution
        ? "pass"
        : "fail",
      summary: "structured",
    }),
  });

  assert.equal(reviewer.proposalAgentExecutionId, coder.executionId);
  assert.equal(validator.reviewerExecutionId, reviewerExecution.executionId);
  assert.equal(validator.appliedResult, appliedResult);
  assert.equal(validator.validation.status, "pass");
});