import test from "node:test";
import assert from "node:assert/strict";
import {
  RufloDagError,
  RufloDynamicDagScheduler,
  RufloResourceLockManager,
  validateTaskGraph,
} from "../test-dist/ruflo-dag.mjs";

const task = (taskId, overrides = {}) => ({
  taskId,
  sessionId: "session-1",
  role: "coder",
  description: taskId,
  dependencies: [],
  priority: 0,
  status: "pending",
  attempts: 0,
  timeout: 100,
  permissions: ["read", "write", "review", "validate", "proposal"],
  expectedFiles: [],
  readIntent: [],
  writeIntent: [],
  createdAt: `2026-09-01T00:00:00.${taskId}Z`,
  ...overrides,
});

test("validates dependencies, duplicate IDs, missing dependencies, and cycles", () => {
  assert.doesNotThrow(() => validateTaskGraph([
    task("a"),
    task("b"),
    task("c", { dependencies: ["a", "b"] }),
  ]));
  assert.throws(() => validateTaskGraph([task("a", { dependencies: ["missing"] })]), /missing/i);
  assert.throws(() => validateTaskGraph([task("a", { dependencies: ["b"] }), task("b", { dependencies: ["a"] })]), /cycle/i);
  assert.throws(() => validateTaskGraph([task("a"), task("a")]), /duplicated|duplicate/i);
  assert.throws(() => validateTaskGraph([task("a", { role: "unknown" })]), /role/i);
});

test("runs independent tasks in parallel and dependent tasks afterward", async () => {
  const active = { count: 0, max: 0 };
  const order = [];
  const operations = new Map();
  for (const id of ["a", "b", "c"]) {
    operations.set(id, async (current) => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      order.push(`${current.taskId}:start`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(`${current.taskId}:end`);
      active.count -= 1;
      return { value: current.taskId };
    });
  }
  const scheduler = new RufloDynamicDagScheduler({
    sessionId: "session-1",
    tasks: [task("a"), task("b"), task("c", { dependencies: ["a", "b"] })],
    operations,
    limits: { maxConcurrentAgents: 2, maxTasks: 5 },
  });
  const result = await scheduler.run();
  assert.equal(result.status, "completed");
  assert.equal(active.max, 2);
  assert.ok(order.indexOf("c:start") > order.indexOf("a:end"));
  assert.ok(order.indexOf("c:start") > order.indexOf("b:end"));
});

test("enforces concurrency, timeout, and bounded retries", async () => {
  let active = 0;
  let maximum = 0;
  const operations = new Map([
    ["a", async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    }],
    ["b", async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    }],
    ["c", async () => new Promise((resolve) => setTimeout(resolve, 50))],
    ["d", async () => { throw new Error("retryable failure"); }],
  ]);
  const scheduler = new RufloDynamicDagScheduler({
    sessionId: "session-1",
    tasks: [
      task("a"),
      task("b"),
      task("c", { timeout: 5 }),
      task("d"),
    ],
    operations,
    limits: { maxConcurrentAgents: 2, maxRetries: 1, maxTasks: 6 },
  });
  const result = await scheduler.run();
  assert.ok(maximum <= 2);
  assert.equal(result.tasks.find((current) => current.taskId === "c").status, "failed");
  assert.equal(result.tasks.find((current) => current.taskId === "d").attempts, 2);
});

test("isolates failures and blocks only dependent tasks", async () => {
  const scheduler = new RufloDynamicDagScheduler({
    sessionId: "session-1",
    tasks: [task("failed"), task("blocked", { dependencies: ["failed"] }), task("independent")],
    operations: new Map([
      ["failed", async () => { throw new Error("failed task"); }],
      ["blocked", async () => { throw new Error("should not run"); }],
      ["independent", async () => "safe"],
    ]),
    limits: { maxRetries: 0 },
  });
  const result = await scheduler.run();
  assert.equal(result.tasks.find((current) => current.taskId === "failed").status, "failed");
  assert.equal(result.tasks.find((current) => current.taskId === "blocked").status, "blocked");
  assert.equal(result.tasks.find((current) => current.taskId === "independent").status, "completed");
});

test("protects writes, permits read/read, and cleans up locks", async () => {
  const manager = new RufloResourceLockManager();
  const releaseReadA = manager.tryAcquire("session-1", "a", ["src/a.ts"], []);
  const releaseReadB = manager.tryAcquire("session-1", "b", ["src/a.ts"], []);
  assert.equal(manager.snapshot().length, 2);
  const blockedWrite = manager.tryAcquire("session-1", "c", [], ["src/a.ts"]);
  assert.equal(manager.snapshot().length, 2);
  releaseReadA();
  releaseReadB();
  assert.equal(manager.snapshot().length, 0);
  const releaseWrite = manager.tryAcquire("session-1", "c", [], ["src/a.ts"]);
  const blockedRead = manager.tryAcquire("session-1", "d", ["src/a.ts"], []);
  assert.equal(manager.snapshot().length, 1);
  assert.equal(typeof blockedWrite, "function");
  assert.equal(typeof blockedRead, "function");
  releaseWrite();
  assert.equal(manager.snapshot().length, 0);
});

test("detects overlapping writes and stale workspace results", async () => {
  const scheduler = new RufloDynamicDagScheduler({
    sessionId: "session-1",
    tasks: [
      task("writer-a", { writeIntent: ["src/shared.ts"], expectedFiles: ["src/shared.ts"] }),
      task("writer-b", { writeIntent: ["src/shared.ts"], expectedFiles: ["src/shared.ts"] }),
      task("stale", { writeIntent: ["src/stale.ts"], expectedFiles: ["src/stale.ts"] }),
    ],
    operations: new Map([
      ["writer-a", async () => ({ changedFiles: ["src/shared.ts"] })],
      ["writer-b", async () => ({ changedFiles: ["src/shared.ts"] })],
      ["stale", async () => ({ changedFiles: ["src/stale.ts"], workspaceRevision: "old" })],
    ]),
    getWorkspaceRevision: async () => "new",
    limits: { maxConcurrentAgents: 1, maxRetries: 0 },
  });
  const result = await scheduler.run();
  assert.equal(result.conflicts.length, 2);
  assert.ok(result.conflicts.some((conflict) => conflict.kind === "write_write"));
  assert.ok(result.conflicts.some((conflict) => conflict.kind === "stale_workspace"));
});
