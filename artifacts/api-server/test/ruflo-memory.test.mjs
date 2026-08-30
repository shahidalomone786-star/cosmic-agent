import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMemoryContext,
  MAX_RUFLO_MEMORY_CONTEXT_CHARS,
  MAX_RUFLO_MEMORY_FACT_CHARS,
  sanitizeMemoryFact,
} from "../test-dist/ruflo-memory-policy.mjs";

test("Ruflo memory redacts credential-shaped values and bounds facts", () => {
  const value = sanitizeMemoryFact(`token=ghp_sensitive-value ${"x".repeat(MAX_RUFLO_MEMORY_FACT_CHARS + 50)}`);
  assert.ok(value.includes("[redacted]"));
  assert.ok(!value.includes("ghp_sensitive-value"));
  assert.ok(value.length <= MAX_RUFLO_MEMORY_FACT_CHARS);
});

test("Ruflo historical memory stays bounded and explicitly lower priority", () => {
  const context = formatMemoryContext(Array.from({ length: 40 }, (_, index) => ({
    kind: "technology",
    fact: `Fact ${index} ${"y".repeat(800)}`,
  })));
  assert.ok(context.startsWith("HISTORICAL RUFLO MEMORY"));
  assert.ok(context.includes("current repository evidence is authoritative"));
  assert.ok(context.length <= MAX_RUFLO_MEMORY_CONTEXT_CHARS);
});