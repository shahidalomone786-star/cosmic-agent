import test from "node:test";
import assert from "node:assert/strict";
import { findWorkerConflicts, verifyEvidenceForTrace } from "../test-dist/evidence-verifier.mjs";

const finding = { claim: "API exists", evidence: "POST /api/settings exists", sourceToolCallId: "trace-1", critical: true };
const trace = {
  toolCallId: "trace-1",
  taskId: "task-1",
  role: "backend",
  tool: "read_file",
  status: "completed",
  startedAt: "2026-08-23T00:00:00.000Z",
  completedAt: "2026-08-23T00:00:01.000Z",
  inputSummary: "path=routes/settings.ts",
  evidence: { summary: "source", content: '"content":"POST /api/settings exists"' },
};

test("accepts valid server evidence", () => {
  assert.equal(verifyEvidenceForTrace(trace, "task-1", finding).result, "match");
});

test("rejects an invalid or fabricated tool id as insufficient", () => {
  assert.equal(verifyEvidenceForTrace(undefined, "task-1", { ...finding, sourceToolCallId: "fake-id" }).result, "insufficient");
});

test("rejects evidence from another task", () => {
  assert.equal(verifyEvidenceForTrace(trace, "other-task", finding).result, "insufficient");
});

test("rejects evidence owned by the wrong worker", () => {
  assert.equal(verifyEvidenceForTrace(trace, "task-1", finding, "frontend").result, "insufficient");
});

test("rejects incomplete tool results", () => {
  assert.equal(verifyEvidenceForTrace({ ...trace, completedAt: undefined }, "task-1", finding).result, "insufficient");
  assert.equal(verifyEvidenceForTrace({ ...trace, evidence: undefined }, "task-1", finding).result, "insufficient");
});

test("does not turn an unsupported claim into a match", () => {
  assert.equal(verifyEvidenceForTrace(trace, "task-1", { ...finding, evidence: "DELETE everything" }).result, "mismatch");
});

test("routes contradictory worker claims to conflict handling", () => {
  const reports = [
    { role: "frontend", dependencies: ["POST /api/settings exists"] },
    { role: "backend", dependencies: ["POST /api/settings exists"] },
  ];
  assert.deepEqual(findWorkerConflicts(reports), ["post /api/settings exists"]);
});