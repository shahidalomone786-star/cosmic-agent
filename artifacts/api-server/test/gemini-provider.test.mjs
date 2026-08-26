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
    const provider = new GeminiProvider([{
      id: "gemini-3.5-flash",
      displayName: "Gemini 3.5 Flash",
      provider: "gemini",
      capabilities: ["fast"],
      contextWindow: 1_048_576,
      enabled: true,
      recommended: false,
    }], keyManager);
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