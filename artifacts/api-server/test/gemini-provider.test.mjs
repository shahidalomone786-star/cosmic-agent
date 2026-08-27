import test from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "../test-dist/gemini-provider.mjs";

function fakeKeyManager() {
  const leases = [
    { id: "gemini-key-1", secret: "server-secret-1" },
    { id: "gemini-key-2", secret: "server-secret-2" },
  ];
  const state = { index: 0, rateLimited: [], failures: [] };
  return {
    state,
    getStatus: () => ({ configured: 5, available: 5, keys: [] }),
    acquire: () => leases[state.index++],
    markSuccess: () => undefined,
    markRateLimited: (id) => state.rateLimited.push(id),
    markFailure: (id) => state.failures.push(id),
  };
}

function providerWith(keyManager) {
  return new GeminiProvider([{
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    provider: "gemini",
    capabilities: ["fast"],
    contextWindow: 1_048_576,
    enabled: true,
    recommended: false,
  }], keyManager);
}

test("Gemini 429 cools down one key and performs only one bounded fallback attempt", async () => {
  const keyManager = fakeKeyManager();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    if (requests.length === 1) return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), { status: 429 });
    return new Response(JSON.stringify({
      responseId: "response-1",
      candidates: [{ content: { parts: [{ text: "GEMINI_OK" }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const provider = providerWith(keyManager);
    const result = await provider.chat({ model: "gemini-3.5-flash", messages: [{ role: "user", content: "hello" }] });
    assert.equal(result.content, "GEMINI_OK");
    assert.equal(requests.length, 2);
    assert.deepEqual(keyManager.state.rateLimited, ["gemini-key-1"]);
    assert.match(requests[0], /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash:generateContent/);
    assert.ok(requests[0].includes("key=server-secret-1"));
    assert.ok(requests[1].includes("key=server-secret-2"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini retries transient network failures and 5xx responses across independent slots", async () => {
  const leases = [
    { id: "gemini-key-1", secret: "network-key" },
    { id: "gemini-key-2", secret: "server-key" },
    { id: "gemini-key-3", secret: "five-hundred-key" },
    { id: "gemini-key-4", secret: "success-key" },
  ];
  const state = { index: 0, failures: [] };
  const keyManager = {
    getStatus: () => ({ configured: leases.length, available: leases.length, keys: [] }),
    acquire: () => leases[state.index++],
    markSuccess: () => undefined,
    markRateLimited: () => undefined,
    markFailure: (id) => state.failures.push(id),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    if (state.failures.length === 0) throw new Error("socket reset");
    if (state.failures.length === 1) return new Response("upstream unavailable", { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "RECOVERED" }] } }] }), { status: 200 });
  };
  try {
    const result = await providerWith(keyManager).chat({ model: "gemini-3.5-flash", role: "backend", messages: [{ role: "user", content: "hello" }] });
    assert.equal(result.content, "RECOVERED");
    assert.deepEqual(state.failures, ["gemini-key-1", "gemini-key-2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quota-style 403 responses are treated as rate limits and fail cleanly when all slots are unavailable", async () => {
  const state = { index: 0, rateLimited: [] };
  const leases = [
    { id: "gemini-key-1", secret: "quota-key-1" },
    { id: "gemini-key-2", secret: "quota-key-2" },
  ];
  const keyManager = {
    getStatus: () => ({ configured: 2, available: 2, keys: [] }),
    acquire: () => leases[state.index++],
    markSuccess: () => undefined,
    markRateLimited: (id) => state.rateLimited.push(id),
    markFailure: () => undefined,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "quota resource exhausted" } }), { status: 403 });
  try {
    await assert.rejects(
      () => providerWith(keyManager).chat({ model: "gemini-3.5-flash", messages: [{ role: "user", content: "hello" }] }),
      (error) => error.code === "temporary_failure" && /all configured Gemini keys/i.test(error.message),
    );
    assert.deepEqual(state.rateLimited, ["gemini-key-1", "gemini-key-2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("five concurrent role requests acquire separate key slots", async () => {
  const leases = Array.from({ length: 5 }, (_, index) => ({ id: `gemini-key-${index + 1}`, secret: `concurrent-${index + 1}` }));
  const state = { index: 0, used: [] };
  const keyManager = {
    getStatus: () => ({ configured: 5, available: 5, keys: [] }),
    acquire: () => {
      const lease = leases[state.index++];
      if (lease) state.used.push(lease.id);
      return lease;
    },
    markSuccess: () => undefined,
    markRateLimited: () => undefined,
    markFailure: () => undefined,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /key=concurrent-/);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ROLE_OK" }] } }] }), { status: 200 });
  };
  try {
    const roles = ["manager", "frontend", "backend", "reviewer", "validator"];
    const results = await Promise.all(roles.map((role) => providerWith(keyManager).chat({ model: "gemini-3.5-flash", role, messages: [{ role: "user", content: role }] })));
    assert.deepEqual(results.map((result) => result.content), ["ROLE_OK", "ROLE_OK", "ROLE_OK", "ROLE_OK", "ROLE_OK"]);
    assert.deepEqual(state.used, leases.map((lease) => lease.id));
  } finally {
    globalThis.fetch = originalFetch;
  }
});