import test from "node:test";
import assert from "node:assert/strict";
import { isCodingRequest } from "../test-dist/coding-intent.mjs";

test("routes implementation language into Agent Mode", () => {
  for (const request of [
    "Create a React component for the dashboard",
    "Fix the backend endpoint error",
    "Rename the config file and update imports",
    "Add a database migration",
  ]) {
    assert.equal(isCodingRequest(request), true, request);
  }
});

test("does not classify ordinary explanation as a coding request", () => {
  assert.equal(isCodingRequest("Explain why this architecture uses a queue"), false);
  assert.equal(isCodingRequest("What does this function do?"), false);
});