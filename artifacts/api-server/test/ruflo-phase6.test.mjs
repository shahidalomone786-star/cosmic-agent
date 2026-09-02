import assert from "node:assert/strict";
import test from "node:test";

const specialized = await import("../test-dist/ruflo-specialized-agents.mjs");
const jobs = await import("../test-dist/ruflo-jobs.mjs");

const proposal = (files = ["tests/generated.test.ts"]) => ({
  proposalId: "proposal-phase6",
  affectedFiles: files,
  files: files.map((path) => ({ path, operation: "create", content: "export {};" })),
  risk: "low",
});

const inspection = {
  files: [
    { path: "src/orders.ts", kind: "source", content: "export function createOrder() {}" },
    { path: "src/routes.ts", kind: "source", content: "export function getOrders() {}" },
    { path: "tests/orders.test.ts", kind: "test", content: "createOrder" },
    { path: "README.md", kind: "documentation", content: "# API" },
  ],
  apiBehavior: "GET /orders",
  references: ["src/orders.ts"],
};

test("Phase 6 selects only the minimum specialized roles", () => {
  assert.deepEqual(specialized.selectRufloSpecializedAgents("add coverage and update the API docs"), ["test_generator", "documentation"]);
  assert.deepEqual(specialized.selectRufloSpecializedAgents("show git history"), ["git_intelligence"]);
  assert.deepEqual(specialized.selectRufloSpecializedAgents("run a rendered browser UI check"), ["browser"]);
  assert.deepEqual(specialized.selectRufloSpecializedAgents("fix a typo"), []);
});

test("Test Generator inspects bounded source/tests and creates a proposal", async () => {
  let request;
  const result = await new specialized.RufloTestGeneratorAgent().run({
    task: "add coverage",
    selectedFiles: ["src/orders.ts"],
    inspect: async (value) => { request = value; return inspection; },
    createProposal: async (value) => {
      assert.equal(value.sourceRole, "test_generator");
      assert.match(value.task, /coverage gaps/i);
      return proposal();
    },
  });
  assert.equal(request.maxFiles, 24);
  assert.equal(result.status, "completed");
  assert.equal(result.proposal.proposalId, "proposal-phase6");
  assert.deepEqual(result.changedFiles, ["tests/generated.test.ts"]);
});

test("Documentation Agent avoids unrelated rewrites and uses the proposal boundary", async () => {
  const result = await new specialized.RufloDocumentationAgent().run({
    task: "document the API",
    selectedFiles: ["src/routes.ts", "README.md"],
    inspect: async () => inspection,
    createProposal: async (value) => {
      assert.equal(value.sourceRole, "documentation");
      assert.match(value.task, /unrelated documentation/i);
      return proposal(["README.md"]);
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changedFiles, ["README.md"]);
});

test("Git Intelligence is read-only and preserves bounded repository evidence", async () => {
  let called = 0;
  const result = await new specialized.RufloGitIntelligenceAgent().run({
    task: "inspect status and diffs",
    read: async () => {
      called += 1;
      return {
        status: { branch: "main", clean: false, stagedFiles: ["src/orders.ts"] },
        branches: ["main", "feature/orders"],
        commits: [{ sha: "abc123", message: "add orders", author: "dev" }],
        diffs: [{ path: "src/orders.ts", status: "modified", additions: 2, deletions: 1 }],
        changedFiles: ["src/orders.ts"],
      };
    },
  });
  assert.equal(called, 1);
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(result.analysis.status.stagedFiles, ["src/orders.ts"]);
});

test("Browser Agent safely reports unavailable when no runtime exists", async () => {
  const result = await new specialized.RufloBrowserAgent().run({
    task: "check page",
    urls: ["https://example.com/"],
    allowedOrigins: ["https://example.com"],
  });
  assert.equal(result.status, "unavailable");
  assert.match(result.summary, /No browser automation driver/i);
});

test("Browser Agent rejects credentials and domains outside the allowlist", () => {
  assert.throws(
    () => specialized.assertAllowedBrowserUrl("https://user:password@example.com/", ["https://example.com"]),
    (error) => error.code === "invalid_url",
  );
  assert.throws(
    () => specialized.assertAllowedBrowserUrl("https://evil.example.net/", ["https://example.com"]),
    (error) => error.code === "domain_not_allowed",
  );
});

test("Browser Agent bounds pages/actions and only returns allowlisted links", async () => {
  await assert.rejects(
    () => new specialized.RufloBrowserAgent().run({
      task: "check pages",
      urls: Array.from({ length: 9 }, (_, index) => `https://example.com/${index}`),
      allowedOrigins: ["https://example.com"],
    }),
    (error) => error.code === "limit",
  );
  const result = await new specialized.RufloBrowserAgent().run({
    task: "check page",
    urls: ["https://example.com/"],
    allowedOrigins: ["https://example.com"],
    driver: {
      navigate: async (url) => ({ url, title: "Example" }),
      inspect: async () => ({ text: "safe", links: ["https://example.com/next", "https://evil.test/"] }),
      act: async () => ({ ok: true }),
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.analysis.pages[0].links, ["https://example.com/next"]);
});

test("DAG accepts specialized roles and runs independent work in parallel", async () => {
  const seen = [];
  const result = await specialized.runRufloSpecializedDag({
    sessionId: "session-phase6",
    task: "add tests and docs",
    selectedFiles: ["src/orders.ts"],
    roles: ["test_generator", "documentation"],
    inspect: async () => inspection,
    createProposal: async ({ sourceRole }) => proposal([sourceRole === "test_generator" ? "tests/generated.test.ts" : "README.md"]),
    onTask: (task) => seen.push(`${task.role}:${task.status}`),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.completedTaskIds.length, 2);
  assert.ok(seen.some((value) => value.includes("in_progress")));
  assert.equal(result.agentExecutions.length, 2);
});

test("specialized memory hooks receive sanitized, source-linked outcomes", async () => {
  const memories = [];
  await specialized.runRufloSpecializedDag({
    sessionId: "session-phase6",
    task: "inspect git",
    selectedFiles: [],
    roles: ["git_intelligence"],
    inspect: async () => inspection,
    git: async () => ({
      status: { branch: "main", clean: true },
      branches: ["main"],
      commits: [{ sha: "abc", message: "token=secret-value" }],
      diffs: [],
      changedFiles: [],
    }),
    remember: async (value) => memories.push(value),
  });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].sourceTaskId.startsWith("specialized-git_intelligence-"), true);
  assert.doesNotMatch(memories[0].fact, /secret-value/);
});

test("job state is persisted through the store and ownership is enforced", async () => {
  const store = new jobs.InMemoryRufloJobStore();
  const states = [];
  const manager = new jobs.RufloJobManager({ store, maxConcurrentJobs: 1, onState: (job, event) => states.push(event) });
  const created = await manager.enqueue({ ownerId: "user-a", sessionId: "session-a", kind: "test", maxRetries: 0, execute: async () => "done" });
  assert.equal((await manager.get("user-b", created.id)), undefined);
  await waitFor(async () => (await manager.get("user-a", created.id))?.status === "completed");
  assert.equal((await manager.get("user-a", created.id)).resultSummary, "done");
  assert.deepEqual(states, ["queued", "started", "completed"]);
});

test("job failures recover within the retry limit", async () => {
  const store = new jobs.InMemoryRufloJobStore();
  const manager = new jobs.RufloJobManager({ store, maxConcurrentJobs: 1 });
  let attempts = 0;
  const created = await manager.enqueue({
    ownerId: "user-a",
    sessionId: "session-a",
    kind: "retry",
    maxRetries: 1,
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return { message: "recovered" };
    },
  });
  await waitFor(async () => (await manager.get("user-a", created.id))?.status === "completed");
  assert.equal(attempts, 2);
  assert.equal((await manager.get("user-a", created.id)).attempts, 2);
});

test("job runtime limits produce a terminal failure", async () => {
  const manager = new jobs.RufloJobManager({ store: new jobs.InMemoryRufloJobStore(), maxConcurrentJobs: 1 });
  const created = await manager.enqueue({
    ownerId: "user-a",
    sessionId: "session-a",
    kind: "timeout",
    maxRetries: 0,
    maxRuntimeMs: 1_000,
    execute: async () => new Promise((resolve) => setTimeout(resolve, 2_000)),
  });
  await waitFor(async () => (await manager.get("user-a", created.id))?.status === "failed", 2_500);
  assert.match((await manager.get("user-a", created.id)).error, /runtime limit/i);
});

test("queued jobs can be cancelled without executing", async () => {
  const manager = new jobs.RufloJobManager({ store: new jobs.InMemoryRufloJobStore(), maxConcurrentJobs: 1 });
  const first = await manager.enqueue({
    ownerId: "user-a",
    sessionId: "session-a",
    kind: "long",
    maxRetries: 0,
    execute: async () => new Promise((resolve) => setTimeout(resolve, 200)),
  });
  const second = await manager.enqueue({
    ownerId: "user-a",
    sessionId: "session-a",
    kind: "cancelled",
    maxRetries: 0,
    execute: async () => { throw new Error("must not execute"); },
  });
  const cancelled = await manager.cancel("user-a", second.id);
  assert.equal(cancelled.status, "cancelled");
  await waitFor(async () => (await manager.get("user-a", first.id))?.status === "completed");
  assert.equal((await manager.get("user-a", second.id)).status, "cancelled");
});

test("job concurrency remains bounded", async () => {
  let active = 0;
  let maximum = 0;
  const manager = new jobs.RufloJobManager({ store: new jobs.InMemoryRufloJobStore(), maxConcurrentJobs: 2 });
  const records = await Promise.all(Array.from({ length: 4 }, (_, index) => manager.enqueue({
    ownerId: "user-a",
    sessionId: "session-a",
    kind: `bounded-${index}`,
    maxRetries: 0,
    execute: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
    },
  })));
  await waitFor(async () => {
    const current = await Promise.all(records.map((record) => manager.get("user-a", record.id)));
    return current.every((record) => record.status === "completed");
  });
  assert.ok(maximum <= 2);
});

test("specialized proposals remain proposal-only and Normal Agent roles remain available", () => {
  assert.equal(specialized.RufloSpecializedAgentRole, undefined);
  assert.deepEqual(new Set(["planner", "coder", "reviewer", "validator", "fixer"]), new Set(["planner", "coder", "reviewer", "validator", "fixer"]));
  assert.equal("writeIntent" in { permissions: ["read", "proposal"], writeIntent: [] }, true);
});

async function waitFor(predicate, timeout = 1_500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for bounded Ruflo state.");
}