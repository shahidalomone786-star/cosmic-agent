import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const bundle = (source, output, format = "esm") => {
  execFileSync("pnpm", [
    "exec", "esbuild", source, "--bundle", "--platform=node", `--format=${format}`,
    "--external:pino", "--external:pino-pretty", `--outfile=${output}`,
  ], { cwd: process.cwd(), stdio: "ignore" });
};

bundle("src/ruflo/ruflo-phase12.ts", "test-dist/ruflo-phase12.mjs");
bundle("src/ai/agent-runtime.ts", "test-dist/agent-runtime-phase12.cjs", "cjs");

const phase12 = await import("../test-dist/ruflo-phase12.mjs");
const agentRuntime = await import("../test-dist/agent-runtime-phase12.cjs");

const node = (id, dependencies = [], task = "read bounded evidence") => ({
  id,
  task,
  agent: "phase12-researcher-1",
  toolDependencies: ["read_file"],
  dependencies,
  boundedIO: { maxInputBytes: 16_000, maxOutputBytes: 32_000 },
  state: dependencies.length ? "PENDING" : "READY",
  retries: 0,
  maxRetries: 1,
  timeoutMs: 1_000,
  approvalRequired: false,
});

test("rejects cyclic and recursive Phase 12 plans", () => {
  assert.throws(() => phase12.validatePhase12Dag([node("a", ["b"]), node("b", ["a"])]), /cycle/i);
  assert.throws(() => phase12.validatePhase12Dag([node("a", [], "spawn another planner recursively")]), /recursive/i);
});

test("runs bounded DAG nodes and preserves cancellation", async () => {
  const calls = [];
  const result = await phase12.runPhase12Dag({
    sessionId: "phase12-session",
    nodes: [node("a"), node("b", ["a"])],
    operations: new Map([
      ["a", async () => { calls.push("a"); return { readFiles: ["src/a.ts"], value: "a" }; }],
      ["b", async () => { calls.push("b"); return { readFiles: ["src/b.ts"], value: "b" }; }],
    ]),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(result.nodes.every((item) => item.state === "SUCCEEDED"), true);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await phase12.runPhase12Dag({
    sessionId: "phase12-cancel",
    nodes: [node("a")],
    operations: new Map([["a", async () => ({ ok: true })]]),
    signal: controller.signal,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.nodes[0].state, "CANCELLED");
});

test("retries transient node failures within the declared bound and blocks dependents", async () => {
  let attempts = 0;
  const states = [];
  const retried = await phase12.runPhase12Dag({
    sessionId: "phase12-retry",
    nodes: [node("a"), node("b", ["a"])],
    operations: new Map([
      ["a", async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider timeout");
        return { ok: true };
      }],
      ["b", async () => ({ ok: true })],
    ]),
    onNode: (item) => states.push([item.id, item.state]),
  });
  assert.equal(retried.status, "completed");
  assert.equal(attempts, 2);
  assert.ok(states.some(([id, state]) => id === "a" && state === "RETRYING"));

  const blocked = await phase12.runPhase12Dag({
    sessionId: "phase12-blocked",
    nodes: [{ ...node("a"), maxRetries: 0 }, node("b", ["a"])],
    operations: new Map([
      ["a", async () => { throw new Error("validation failed"); }],
      ["b", async () => ({ shouldNotRun: true })],
    ]),
  });
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.nodes.find((item) => item.id === "b").state, "BLOCKED");
});

test("holds approval nodes and never promotes disabled or metadata-only tools", async () => {
  const waiting = await phase12.runPhase12Dag({
    sessionId: "phase12-approval",
    nodes: [{ ...node("proposal"), approvalRequired: true }],
    operations: new Map([["proposal", async () => ({ changedFiles: ["src/app.ts"] })]]),
  });
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.nodes[0].state, "WAITING_APPROVAL");

  const registry = {
    has: (id) => ["enabled", "disabled", "metadata"].includes(id),
    get: (id) => ({
      id,
      enabled: id === "enabled",
      availability: id === "disabled" ? "disabled" : "enabled",
      implementationKind: id === "metadata" ? "metadata-only" : id === "disabled" ? "disabled" : "cosmic-adapter",
      agentAccess: { rufloOnly: true, allowedAgentTypes: ["researcher"] },
    }),
  };
  assert.deepEqual(phase12.selectPhase12Tools(registry, ["enabled", "disabled", "metadata"]).map((tool) => tool.id), ["enabled"]);
});

test("classifies failures, refuses unsafe retries, and diagnoses without inventing root cause", () => {
  assert.equal(phase12.classifyPhase12Failure(new Error("permission denied")), "AUTHORIZATION");
  assert.equal(phase12.canRetryPhase12("AUTHORIZATION"), false);
  assert.equal(phase12.canRetryPhase12("TIMEOUT"), true);
  const diagnostic = phase12.diagnosePhase12Failure(new Error("provider timeout"), { nodeId: "n1", requestId: "r1" });
  assert.equal(diagnostic.category, "TIMEOUT");
  assert.match(diagnostic.rootCause, /ROOT CAUSE NOT CONFIRMED/);
  assert.equal(diagnostic.nodeId, "n1");
});

test("scopes experiences and checkpoints to the exact owner/session/workspace", async () => {
  const scope = phase12.createPhase12MemoryScope({ userId: "u", projectId: "p", workspaceId: "w", sessionId: "s" });
  const experience = phase12.createPhase12Experience({ scope, pattern: "bounded retry", provenance: "phase12-test", confidence: 0.8 });
  assert.deepEqual(experience.scope, scope);
  assert.ok(experience.expiresAt);
  const store = new phase12.InMemoryPhase12CheckpointStore();
  const checkpoint = await store.save({
    id: "checkpoint-1", ownerId: "u", projectId: "p", sessionId: "s",
    nodeStates: { a: "SUCCEEDED" }, outputs: { a: { ok: true } }, approvalVersion: "v1", createdAt: new Date().toISOString(),
  });
  assert.ok(await store.get("u", "s", checkpoint.id));
  assert.equal(await store.get("other", "s", checkpoint.id), undefined);
  assert.throws(() => phase12.assertPhase12Resume(checkpoint, { ownerId: "u", projectId: "p", sessionId: "s", approvalVersion: "v2" }), /approval binding/i);
});

test("keeps provider traces bounded and Normal Agent rejects Ruflo authority names", () => {
  const traces = phase12.createPhase12ProviderTraces("s", {
    capability: "medium",
    reason: "bounded selection",
    primary: { provider: { id: "gemini" }, model: { id: "model" } },
    fallbacks: [],
    availableProviders: [],
  }, [{ provider: "gemini", model: "model", capability: "medium", fallbackUsed: false }]);
  assert.deepEqual(traces[0], {
    sessionId: "s", capability: "medium", provider: "gemini", model: "model",
    reason: "bounded selection", fallbackUsed: false, classification: undefined,
  });
  assert.equal(agentRuntime.isNormalAgentRufloAuthorityName("ruflo:agent_spawn"), true);
  assert.equal(agentRuntime.isNormalAgentRufloAuthorityName("repository_search"), false);
});

test("binds leases to one owner and keeps authority actions behind Cosmic approval", () => {
  const agent = phase12.createPhase12Agents(["researcher"], new Date("2026-09-06T00:00:00.000Z"))[0];
  const leased = phase12.acquirePhase12Lease(agent, "owner-a", new Date("2026-09-06T00:00:00.000Z"));
  assert.throws(() => phase12.acquirePhase12Lease(leased, "owner-b", new Date("2026-09-06T00:00:01.000Z")), /leased by another owner/i);
  const heartbeated = phase12.heartbeatPhase12Lease(leased, "owner-a", new Date("2026-09-06T00:00:02.000Z"));
  assert.equal(heartbeated.lease.owner, "owner-a");
  assert.equal(phase12.requestPhase12Cancellation(heartbeated, "owner-a").cancellationRequested, true);
  assert.throws(() => phase12.assertPhase12Authority("apply"), /Cosmic approval/i);
  assert.doesNotThrow(() => phase12.assertPhase12Authority("propose"));
});