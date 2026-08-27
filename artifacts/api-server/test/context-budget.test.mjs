import test from "node:test";
import assert from "node:assert/strict";
import { fitContext } from "../test-dist/context-budget.mjs";
import { chunkContext } from "../test-dist/context-manager.mjs";

test("context bundles deduplicate repeated source keys while preserving explicit priority", () => {
  const result = fitContext([
    { key: "summary", text: "Framework: React\nFramework: React", relevance: 10, explicit: true },
    { key: "summary", text: "Framework: React", relevance: 99 },
    { key: "src/App.tsx", text: "export function App() {}", relevance: 8 },
  ]);
  assert.deepEqual(result.includedKeys, ["summary", "src/App.tsx"]);
  assert.equal(result.text.includes("Framework: React\nFramework: React"), false);
  assert.equal(result.text.match(/Framework: React/g).length, 1);
});

test("large files keep the question-relevant line range instead of always taking the file head", () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line-${index + 1}`);
  const result = chunkContext("src/target.ts", lines.join("\n"), 120, { startLine: 150, endLine: 155 });
  assert.equal(result.chunked, true);
  assert.ok(result.text.includes("line-150"));
  assert.equal(result.startLine > 1, true);
});