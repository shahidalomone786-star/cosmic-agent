import test from "node:test";
import assert from "node:assert/strict";
import { runRufloSession } from "../test-dist/ruflo-runtime.cjs";

function provider(id = "gemini") {
  return {
    id,
    chat: async () => ({ id: "test", model: "test", provider: id, content: "{}" }),
    stream: async () => ({ id: "test", model: "test", provider: id, content: "" }),
    getModels: () => [],
    healthCheck: () => ({ available: true, configured: true, message: "test" }),
  };
}

function plan() {
  return {
    goal: "inspect",
    steps: [{ id: "inspect", title: "Inspect", description: "Inspect evidence", status: "active" }],
  };
}

function planner(decisions) {
  let index = 0;
  return {
    createPlan: async () => plan(),
    decide: async () => decisions[Math.min(index++, decisions.length - 1)],
  };
}

function tools(log, failure) {
  return {
    execute: async (request) => {
      log.push(request.name);
      if (failure) throw failure;
      if (request.name === "inspect_repository") {
        return { name: request.name, summary: "inspected", data: { files: ["src/App.tsx"] }, files: ["src/App.tsx"] };
      }
      if (request.name === "read_file") {
        return { name: request.name, summary: "read", data: { path: request.input.path, content: "const app = true;" }, files: [request.input.path] };
      }
      return { name: request.name, summary: "searched", data: [{ path: "src/App.tsx", line: 1, context: "app" }], files: ["src/App.tsx"] };
    },
  };
}

const repository = { id: "1", owner: "owner", name: "repo", branch: "main", defaultBranch: "main", webUrl: "https://github.com/owner/repo" };

test("returns to the planner after each tool and reaches proposal-ready state", async () => {
  const calls = [];
  const session = await runRufloSession({
    task: "inspect the app",
    model: "test",
    provider: provider(),
    repository,
    planner: planner([
      { action: "inspect_repository", reasoning: "start" },
      { action: "read_file", reasoning: "read evidence", input: { path: "src/App.tsx" } },
      { action: "prepare_proposal", reasoning: "enough evidence" },
    ]),
    tools: tools(calls),
  });

  assert.equal(session.status, "proposal_ready");
  assert.equal(session.proposalReady, true);
  assert.deepEqual(calls, ["inspect_repository", "read_file"]);
  assert.equal(session.observations.length, 2);
  assert.ok(session.events.some((event) => event.type === "decision"));
});

test("stops at the iteration limit instead of looping forever", async () => {
  const calls = [];
  const session = await runRufloSession({
    task: "inspect the app",
    model: "test",
    provider: provider(),
    repository,
    planner: planner([{ action: "search_repository", reasoning: "keep inspecting", input: { query: "app" } }]),
    tools: tools(calls),
    limits: { maxIterations: 2, maxToolCalls: 10 },
  });

  assert.equal(session.status, "limit_reached");
  assert.equal(session.error.code, "iteration_limit");
  assert.equal(session.iteration, 2);
});

test("stops before exceeding the tool-call limit", async () => {
  const calls = [];
  const session = await runRufloSession({
    task: "inspect the app",
    model: "test",
    provider: provider(),
    repository,
    planner: planner([
      { action: "inspect_repository", reasoning: "start" },
      { action: "read_file", reasoning: "read", input: { path: "src/App.tsx" } },
      { action: "search_repository", reasoning: "search", input: { query: "app" } },
    ]),
    tools: tools(calls),
    limits: { maxToolCalls: 2, maxIterations: 4 },
  });

  assert.equal(session.status, "limit_reached");
  assert.equal(session.error.code, "tool_call_limit");
  assert.equal(session.toolCalls, 2);
  assert.equal(calls.length, 2);
});

test("fails closed when inspection returns no readable context", async () => {
  const session = await runRufloSession({
    task: "inspect the app",
    model: "test",
    provider: provider(),
    repository,
    planner: planner([
      { action: "inspect_repository", reasoning: "start" },
      { action: "prepare_proposal", reasoning: "finish" },
    ]),
    tools: {
      execute: async () => ({ name: "inspect_repository", summary: "empty", data: {}, files: [] }),
    },
  });

  assert.equal(session.status, "failed");
  assert.equal(session.error.code, "empty_context");
  assert.equal(session.proposalReady, false);
});

test("stops when the bounded runtime window expires", async () => {
  let time = 0;
  const session = await runRufloSession({
    task: "inspect the app",
    model: "test",
    provider: provider(),
    repository,
    planner: planner([{ action: "inspect_repository", reasoning: "start" }]),
    tools: tools([]),
    limits: { maxRuntimeMs: 1, maxIterations: 10 },
    now: () => {
      time += 2;
      return time;
    },
  });

  assert.equal(session.status, "limit_reached");
  assert.equal(session.error.code, "runtime_limit");
});

test("retries a recoverable tool failure within the retry bound and preserves the real error", async () => {
  let attempts = 0;
  const session = await runRufloSession({
    task: "inspect the app",
    model: "test",
    provider: provider("gemini"),
    fallbackProviders: [provider("groq")],
    repository,
    planner: planner([{ action: "inspect_repository", reasoning: "start" }]),
    tools: {
      execute: async () => {
        attempts += 1;
        const error = new Error("GitHub temporarily unavailable");
        error.retryable = true;
        throw error;
      },
    },
    limits: { maxIterations: 2, maxToolCalls: 4, maxRetries: 1 },
  });

  assert.equal(session.status, "failed");
  assert.equal(session.error.code, "tool_failure");
  assert.match(session.error.message, /GitHub temporarily unavailable/);
  assert.equal(attempts, 2);
  assert.equal(session.retries, 1);
});

test("fails provider planning without hiding the provider error", async () => {
  const failing = {
    ...provider("gemini"),
    chat: async () => {
      const error = new Error("provider quota exhausted");
      error.retryable = true;
      throw error;
    },
  };
  const fallback = {
    ...provider("groq"),
    chat: async () => {
      const error = new Error("fallback unavailable");
      error.retryable = false;
      throw error;
    },
  };
  const session = await runRufloSession({
    task: "inspect the app",
    model: "test",
    provider: failing,
    fallbackProviders: [fallback],
    repository,
    limits: { maxRetries: 1 },
  });

  assert.equal(session.status, "failed");
  assert.equal(session.error.code, "planner_failure");
  assert.match(session.error.message, /fallback unavailable/);
  assert.equal(session.providerAttempts.length, 2);
});