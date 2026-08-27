import test from "node:test";
import assert from "node:assert/strict";
import { GeminiKeyManager } from "../test-dist/gemini-key-manager.mjs";

const secrets = Array.from({ length: 12 }, (_, index) => `server-secret-${index + 1}`);

test("Gemini key manager loads twelve slots and never returns secret material in status", () => {
  const manager = new GeminiKeyManager(secrets);
  const status = manager.getStatus();
  assert.equal(status.configured, 12);
  assert.equal(status.available, 12);
  assert.deepEqual(status.keys.map((key) => key.id), Array.from({ length: 12 }, (_, index) => `gemini-key-${index + 1}`));
  assert.equal(Object.values(status.keys[0]).includes("server-secret-1"), false);
});

test("rate-limited and temporary-failure slots cool down and recover", async () => {
  const manager = new GeminiKeyManager(["one", "two"], 5);
  const first = manager.acquire();
  assert.ok(first);
  manager.markRateLimited(first.id);
  assert.equal(manager.getStatus().keys[0].status, "rate_limited");
  assert.ok((manager.getStatus().keys[0].cooldownUntil ?? 0) > Date.now());
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(manager.getStatus().keys[0].status, "available");

  const second = manager.acquire();
  assert.ok(second);
  manager.markFailure(second.id);
  assert.equal(manager.getStatus().keys[1].status, "temporarily_failed");
  manager.markFailure(second.id, true);
  assert.equal(manager.getStatus().keys[1].status, "unavailable");
  assert.equal(manager.getStatus().available, 1);
});