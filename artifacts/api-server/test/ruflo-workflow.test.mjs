import test from "node:test";
import assert from "node:assert/strict";
import { runRufloPostApproval, MAX_RUFLO_RECOVERY_ATTEMPTS } from "../test-dist/ruflo-workflow.cjs";

const proposal = (id = "proposal-1", risk = "LOW") => ({
  proposalId: id,
  status: "proposal",
  summary: "Fix the app",
  explanation: "A focused change",
  risk,
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

const input = (overrides = {}) => ({
  proposal: proposal(),
  boundedPaths: ["src/example.ts"],
  recoveryAttempts: 0,
  reviewer: async () => ({ status: "pass", summary: "Reviewer passed." }),
  validator: async () => ({ status: "pass", summary: "Validator passed." }),
  rollback: async () => {},
  createFixProposal: async (_diagnosis, attempt) => proposal(`fix-${attempt}`, "MEDIUM"),
  ...overrides,
});

test("validation success reaches completed", async () => {
  const phases = [];
  const result = await runRufloPostApproval(input({ onPhase: (phase) => phases.push(phase) }));
  assert.equal(result.status, "completed");
  assert.equal(result.phase, "completed");
  assert.deepEqual(phases, ["reviewing", "validating", "completed"]);
  assert.equal(result.validation.status, "pass");
});

test("validation failure rolls back and creates a waiting fix proposal", async () => {
  let rolledBack = false;
  let diagnosis = "";
  const result = await runRufloPostApproval(input({
    validator: async () => ({ status: "fail", summary: "Build failed." }),
    rollback: async () => { rolledBack = true; },
    createFixProposal: async (reason, attempt) => {
      diagnosis = reason;
      return proposal(`fix-${attempt}`, "MEDIUM");
    },
  }));
  assert.equal(rolledBack, true);
  assert.equal(diagnosis, "Build failed.");
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.phase, "waiting_approval");
  assert.equal(result.approvalRequired, true);
  assert.equal(result.approvalRisk, "MEDIUM");
  assert.equal(result.recoveryAttempts, 1);
});

test("recovery can be approved and validated on the next bounded run", async () => {
  const first = await runRufloPostApproval(input({
    validator: async () => ({ status: "not-verified", summary: "The build could not be verified." }),
  }));
  assert.equal(first.status, "waiting_approval");
  const second = await runRufloPostApproval(input({
    proposal: first.proposal,
    recoveryAttempts: first.recoveryAttempts,
  }));
  assert.equal(second.status, "completed");
  assert.equal(second.recoveryAttempts, 1);
});

test("retry limit produces final failure and never creates another fix", async () => {
  let fixCreated = false;
  const result = await runRufloPostApproval(input({
    recoveryAttempts: MAX_RUFLO_RECOVERY_ATTEMPTS,
    validator: async () => ({ status: "fail", summary: "Still failing." }),
    createFixProposal: async () => {
      fixCreated = true;
      return proposal("unexpected");
    },
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.phase, "failed");
  assert.match(result.message, /3 recovery attempts/);
  assert.equal(fixCreated, false);
});

test("fix proposal failure is visible as final failure", async () => {
  const result = await runRufloPostApproval(input({
    validator: async () => ({ status: "fail", summary: "Validation rejected the applied change." }),
    createFixProposal: async () => { throw new Error("Fix generation unavailable."); },
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.phase, "failed");
  assert.match(result.message, /Fix generation unavailable/);
});

test("validator exceptions are treated as failures and rolled back", async () => {
  let rolledBack = false;
  const result = await runRufloPostApproval(input({
    validator: async () => { throw new Error("Validator process crashed."); },
    rollback: async () => { rolledBack = true; },
  }));
  assert.equal(rolledBack, true);
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.validation.status, "not-verified");
  assert.match(result.validation.summary, /Validator process crashed/);
});

test("recovery never auto-applies a code-changing fix", async () => {
  let applyCalled = false;
  const result = await runRufloPostApproval(input({
    validator: async () => ({ status: "fail", summary: "Typecheck failed." }),
    createFixProposal: async (_diagnosis, attempt) => {
      applyCalled = true;
      return proposal(`fix-${attempt}`);
    },
  }));
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.approvalRequired, true);
  assert.equal(applyCalled, true);
  assert.equal(result.proposal.proposalId, "fix-1");
});