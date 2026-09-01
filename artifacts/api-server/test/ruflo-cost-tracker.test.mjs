import test from "node:test";
import assert from "node:assert/strict";
import {
  RufloCostTracker,
  calculateEstimatedCost,
  estimateTokens,
  RufloBudgetLimitError,
} from "../test-dist/ruflo-cost-tracker.mjs";

const request = {
  model: "model-a",
  messages: [{ role: "user", content: "hello world" }],
};

test("token estimation and known pricing produce session and provider breakdowns", () => {
  assert.equal(estimateTokens("1234"), 1);
  assert.equal(calculateEstimatedCost(100, 50, {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 2,
  }), 0.0002);
  const tracker = new RufloCostTracker({
    limits: { maxSessionTokens: 10_000 },
    pricing: { "groq:model-a": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } },
  });
  tracker.record({
    provider: "groq",
    model: "model-a",
    sessionId: "session-1",
    request,
    inputTokens: 100,
    outputTokens: 50,
    exactTokens: true,
  });
  const totals = tracker.getSessionTotals("session-1");
  assert.equal(totals.totalTokens, 150);
  assert.equal(totals.costStatus, "estimated");
  assert.equal(totals.estimatedCostUsd, 0.0002);
  assert.deepEqual(totals.providerModels[0], {
    provider: "groq",
    model: "model-a",
    requests: 1,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.0002,
    costStatus: "estimated",
  });
});

test("unknown pricing is explicit and never fabricated", () => {
  const tracker = new RufloCostTracker();
  tracker.record({
    provider: "gemini",
    model: "unknown-price",
    sessionId: "session-unknown",
    request,
    inputTokens: 8,
    outputTokens: 4,
  });
  const totals = tracker.getSessionTotals("session-unknown");
  assert.equal(totals.costStatus, "unknown");
  assert.equal(totals.estimatedCostUsd, undefined);
  assert.equal(tracker.getRecords("session-unknown")[0].exactTokens, false);
});

test("session and request hard cost limits fail safely when they cannot be evaluated", () => {
  const tracker = new RufloCostTracker({
    limits: { maxSessionCostUsd: 1, maxRequestCostUsd: 1 },
  });
  assert.throws(() => tracker.record({
    provider: "groq",
    model: "unknown-price",
    sessionId: "cost-session",
    request,
    inputTokens: 2,
    outputTokens: 2,
  }), (error) => error instanceof RufloBudgetLimitError && error.code === "session_cost_budget");
});

test("request cost limits are enforced before a priced request is sent", () => {
  const tracker = new RufloCostTracker({
    limits: { maxRequestCostUsd: 0.0001 },
    pricing: { "groq:model-a": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } },
  });
  assert.throws(() => tracker.preflight({
    sessionId: "request-cost-session",
    provider: "groq",
    request: { ...request, model: "model-a", maxOutputTokens: 100 },
    requestedOutputTokens: 100,
  }), (error) => error instanceof RufloBudgetLimitError && error.code === "request_cost_budget");
});

test("remaining token budget is session-scoped", () => {
  const tracker = new RufloCostTracker({
    limits: { maxInputTokens: 100, maxOutputTokens: 100, maxSessionTokens: 150 },
  });
  tracker.record({
    provider: "groq",
    model: "model-a",
    sessionId: "session-budget",
    request,
    inputTokens: 40,
    outputTokens: 20,
  });
  assert.deepEqual(tracker.getRemainingBudget("session-budget"), {
    inputTokens: 60,
    outputTokens: 80,
    sessionTokens: 90,
    sessionCostUsd: undefined,
    requestCostUsd: undefined,
    providerRetries: 1,
  });
});