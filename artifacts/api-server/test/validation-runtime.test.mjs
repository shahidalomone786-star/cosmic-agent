import test from "node:test";
import assert from "node:assert/strict";
import { verifyValidationResult, validationStatusForTrace } from "../test-dist/validation-runtime.mjs";

const trace = (tool, status = "completed") => ({
  toolCallId: `${tool}-id`,
  taskId: "task-1",
  role: "validator",
  tool,
  status,
  startedAt: "2026-08-23T00:00:00.000Z",
  completedAt: "2026-08-23T00:00:01.000Z",
});
const result = (checks) => ({ taskId: "task-1", status: "pass", checks, toolCallIds: [], summary: "claimed" });

test("real typecheck and build PASS traces produce pass", () => {
  const value = verifyValidationResult(result([
    { name: "typecheck", status: "pass", sourceToolCallId: "run_typecheck-id", details: "completed" },
    { name: "build", status: "pass", sourceToolCallId: "run_build-id", details: "completed" },
  ]), [trace("run_typecheck"), trace("run_build")]);
  assert.equal(value.status, "pass");
  assert.deepEqual(value.toolCallIds, ["run_typecheck-id", "run_build-id"]);
});

test("real typecheck and build FAIL traces produce fail", () => {
  const value = verifyValidationResult(result([
    { name: "typecheck", status: "fail", sourceToolCallId: "run_typecheck-id", details: "compiler failed" },
    { name: "build", status: "fail", sourceToolCallId: "run_build-id", details: "build failed" },
  ]), [trace("run_typecheck", "failed"), trace("run_build", "failed")]);
  assert.equal(value.status, "fail");
});

test("fake and wrong-task tool ids are not verified", () => {
  const value = verifyValidationResult(result([
    { name: "typecheck", status: "pass", sourceToolCallId: "fake-id", details: "claimed" },
    { name: "build", status: "pass", sourceToolCallId: "run_build-id", details: "claimed" },
  ]), [{ ...trace("run_build"), taskId: "other-task" }]);
  assert.equal(value.status, "not-verified");
  assert.equal(value.checks[0].status, "not-verified");
  assert.equal(value.checks[1].status, "not-verified");
});

test("incomplete execution and validator infrastructure failure propagate not-verified", () => {
  assert.equal(validationStatusForTrace({ ...trace("run_build"), completedAt: undefined }), "not-verified");
  assert.equal(validationStatusForTrace({ ...trace("run_build"), status: "timeout" }), "not-verified");
  const value = verifyValidationResult(result([
    { name: "build", status: "pass", sourceToolCallId: "run_build-id", details: "fabricated" },
  ]), [{ ...trace("run_build"), status: "timeout" }]);
  assert.equal(value.status, "not-verified");
});

test("fabricated FAIL claims are also rejected", () => {
  const value = verifyValidationResult(result([
    { name: "typecheck", status: "fail", sourceToolCallId: "run_typecheck-id", details: "fabricated" },
  ]), [trace("run_typecheck")]);
  assert.equal(value.status, "not-verified");
});