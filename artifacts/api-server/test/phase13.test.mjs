import assert from "node:assert/strict";
import test from "node:test";
import * as jobs from "../test-dist/ruflo-jobs.mjs";

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for Phase 13 job state.");
};

test("duplicate idempotency keys return the original job and execute once", async () => {
  const store = new jobs.InMemoryRufloJobStore();
  const manager = new jobs.RufloJobManager({ store, maxConcurrentJobs: 1 });
  let executions = 0;
  const input = {
    ownerId: "phase13-user-a",
    sessionId: "phase13-session-a",
    kind: "idempotent",
    idempotencyKey: "same-action",
    execute: async () => {
      executions += 1;
      return { message: "one side effect" };
    },
  };
  const first = await manager.enqueue(input);
  const second = await manager.enqueue(input);
  await waitFor(async () => (await manager.get(input.ownerId, first.id))?.status === "completed");
  assert.equal(second.id, first.id);
  assert.equal(executions, 1);
});

test("job records cannot be read across users", async () => {
  const store = new jobs.InMemoryRufloJobStore();
  const manager = new jobs.RufloJobManager({ store, maxConcurrentJobs: 1 });
  const created = await manager.enqueue({
    ownerId: "phase13-owner",
    sessionId: "phase13-session",
    kind: "ownership",
    execute: async () => ({ message: "private" }),
  });
  assert.equal(await manager.get("phase13-other-user", created.id), undefined);
});

test("transient jobs retry with a bounded backoff and complete", async () => {
  const store = new jobs.InMemoryRufloJobStore();
  const manager = new jobs.RufloJobManager({ store, maxConcurrentJobs: 1 });
  let attempts = 0;
  const created = await manager.enqueue({
    ownerId: "phase13-retry-user",
    sessionId: "phase13-session",
    kind: "retry",
    maxRetries: 1,
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return { message: "recovered" };
    },
  });
  await waitFor(async () => (await manager.get("phase13-retry-user", created.id))?.status === "completed");
  const finished = await manager.get("phase13-retry-user", created.id);
  assert.equal(finished.attempts, 2);
  assert.equal(attempts, 2);
  assert.ok(finished.nextAttemptAt);
});