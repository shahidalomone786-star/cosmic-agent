import test from "node:test";
import assert from "node:assert/strict";
import { approveProposal, assertApproval, proposalVersion } from "../test-dist/approval-gate.mjs";

const proposal = (suffix = "") => ({
  proposalId: `proposal-${suffix || "one"}`,
  status: "proposal",
  summary: "Safe change",
  explanation: "A test proposal",
  risk: "LOW",
  affectedFiles: ["src/example.ts"],
  addedLines: 1,
  removedLines: 1,
  files: [{
    path: "src/example.ts",
    language: "typescript",
    originalCode: "export const value = 1;\n",
    proposedCode: `export const value = ${suffix || 2};\n`,
    diff: "diff",
    explanation: "Update value",
    addedLines: 1,
    removedLines: 1,
  }],
});

test("approval is required and binds to the exact proposal version", () => {
  const first = proposal();
  assert.throws(() => assertApproval("missing", first, undefined), /approval/i);
  const approval = approveProposal(first, undefined, "authenticated-user", "task-1", "apply", "session-1");
  assert.equal(assertApproval(approval.approvalId, first, undefined, "task-1", "apply", "session-1", "authenticated-user").proposalVersion, proposalVersion(first));
  assert.throws(() => assertApproval(approval.approvalId, first, undefined, "task-1", "apply", "other-session", "authenticated-user"), /approval/i);
  assert.throws(() => assertApproval(approval.approvalId, first, undefined, "task-1", "apply", "session-1", "other-user"), /approval/i);
  assert.throws(() => assertApproval(approval.approvalId, proposal("two"), undefined, "task-1", "apply", "session-1", "authenticated-user"), /approval|stale/i);
  assert.throws(() => assertApproval(approval.approvalId, first, undefined, "task-1", "commit", "session-1", "authenticated-user"), /approval/i);
});

test("approval cannot be created without a user identity", () => {
  assert.throws(() => approveProposal(proposal(), undefined, "   "), /authenticated user/i);
});
