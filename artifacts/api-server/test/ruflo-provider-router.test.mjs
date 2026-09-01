import test from "node:test";
import assert from "node:assert/strict";
import {
  RufloModelRouter,
  RufloProviderGateway,
  classifyRufloProviderFailure,
} from "../test-dist/ruflo-provider-router.mjs";
import { RufloCostTracker, RufloBudgetLimitError } from "../test-dist/ruflo-cost-tracker.mjs";

function model(id, capabilityClasses, strength, costTier, contextWindow = 16_000) {
  return {
    id,
    displayName: id,
    provider: id.startsWith("gemini") ? "gemini" : "groq",
    capabilities: ["coding", "reasoning"],
    capabilityClasses,
    strength,
    costTier,
    contextWindow,
    enabled: true,
    recommended: false,
  };
}

function provider(id, models, health = { available: true, configured: true, message: "configured" }) {
  return {
    id,
    getModels: () => models,
    healthCheck: () => health,
    chat: async () => ({ id: "ok", model: models[0].id, provider: id, content: "ok" }),
    stream: async () => ({ id: "ok", model: models[0].id, provider: id, content: "ok" }),
  };
}

test("provider discovery records health and models without credentials", () => {
  const router = new RufloModelRouter([
    provider("groq", [model("fast", ["light"], 1, "low")]),
    provider("gemini", [model("strong", ["heavy"], 3, "high")], {
      available: false,
      configured: true,
      message: "temporarily unavailable",
    }),
  ]);
  const discovered = router.discover();
  assert.deepEqual(discovered.map((item) => [item.provider, item.health.available]), [
    ["groq", true],
    ["gemini", false],
  ]);
  assert.equal(discovered[0].models[0].id, "fast");
  assert.doesNotMatch(JSON.stringify(discovered), /secret|key-\d/i);
});

test("light, medium, and heavy tasks choose transparent capability routes", () => {
  const router = new RufloModelRouter([
    provider("groq", [
      model("cheap-light", ["light", "medium"], 1, "low"),
      model("balanced", ["medium"], 2, "low"),
      model("strong", ["heavy"], 3, "medium"),
    ]),
  ]);
  assert.equal(router.select({ task: "classify these files", capability: "light" }).primary.model.id, "cheap-light");
  assert.equal(router.select({ task: "debug the API", capability: "medium" }).primary.model.id, "balanced");
  assert.equal(router.select({ task: "design a complex architecture", capability: "heavy" }).primary.model.id, "strong");
  assert.match(router.select({ task: "summarize", capability: "light" }).reason, /LIGHT/);
});

test("unavailable providers and context-incompatible models are excluded", () => {
  const router = new RufloModelRouter([
    provider("groq", [model("offline", ["medium"], 2, "low")], {
      available: false,
      configured: true,
      message: "offline",
    }),
    provider("gemini", [model("too-small", ["medium"], 2, "low", 100)]),
  ]);
  assert.throws(
    () => router.select({ task: "debug", capability: "medium", contextTokens: 90, outputTokens: 20 }),
    /No available configured model/,
  );
});

test("primary retries are bounded before a compatible fallback is used", async () => {
  const calls = [];
  const primaryModel = model("primary", ["medium"], 2, "low");
  const fallbackModel = model("fallback", ["medium"], 2, "low");
  const primary = provider("groq", [primaryModel]);
  primary.chat = async () => {
    calls.push("primary");
    const error = new Error("timed out");
    error.code = "timeout";
    error.retryable = true;
    throw error;
  };
  const fallback = provider("gemini", [fallbackModel]);
  fallback.chat = async () => {
    calls.push("fallback");
    return { id: "fallback", model: "fallback", provider: "gemini", content: "recovered" };
  };
  const decision = new RufloModelRouter([primary, fallback]).select({
    task: "debug",
    capability: "medium",
    requestedModel: "primary",
  });
  const tracker = new RufloCostTracker({
    limits: { maxProviderRetries: 1, maxSessionTokens: 20_000 },
  });
  const gateway = new RufloProviderGateway(decision, tracker, {
    sessionId: "session-1",
    capability: "medium",
  });
  const response = await gateway.chat({
    model: decision.primary.model.id,
    messages: [{ role: "user", content: "debug this" }],
  });
  assert.equal(response.content, "recovered");
  assert.deepEqual(calls, ["primary", "primary", "fallback"]);
  assert.equal(tracker.getSessionTotals("session-1").requests, 3);
});

test("budget limits stop before the provider call and classify failures", async () => {
  let called = false;
  const primaryModel = model("primary", ["medium"], 2, "low");
  const primary = provider("groq", [primaryModel]);
  primary.chat = async () => {
    called = true;
    return { id: "unexpected", model: "primary", provider: "groq", content: "unexpected" };
  };
  const decision = new RufloModelRouter([primary]).select({ task: "debug", capability: "medium" });
  const tracker = new RufloCostTracker({
    limits: { maxInputTokens: 1, maxSessionTokens: 20_000 },
  });
  const gateway = new RufloProviderGateway(decision, tracker, {
    sessionId: "budget-session",
    capability: "medium",
  });
  await assert.rejects(
    () => gateway.chat({ model: "primary", messages: [{ role: "user", content: "hello" }] }),
    (error) => error instanceof RufloBudgetLimitError && error.code === "input_token_budget",
  );
  assert.equal(called, false);
  assert.equal(classifyRufloProviderFailure({ code: "rate_limited" }), "rate_limit");
  assert.equal(classifyRufloProviderFailure({ code: "invalid_configuration" }), "authentication/configuration");
  assert.equal(classifyRufloProviderFailure({ code: "context_limit" }), "context_limit");
});