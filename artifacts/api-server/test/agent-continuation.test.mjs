import test from "node:test";
import assert from "node:assert/strict";
import { resolveProposalPaths } from "../test-dist/agent-continuation.mjs";

test("continues from a read context result into bounded proposal paths", () => {
  assert.deepEqual(
    resolveProposalPaths([], [
      { path: "@/src/App.tsx" },
      { path: "src/App.tsx" },
      { path: "src/styles.css" },
    ]),
    ["/src/App.tsx", "src/App.tsx", "src/styles.css"],
  );
});

test("keeps explicit paths authoritative and bounded", () => {
  const paths = resolveProposalPaths(
    Array.from({ length: 25 }, (_, index) => `@/src/file-${index}.ts`),
    [{ path: "src/discovered.ts" }],
  );

  assert.equal(paths.length, 20);
  assert.equal(paths[0], "/src/file-0.ts");
  assert.equal(paths.at(-1), "/src/file-19.ts");
  assert.ok(!paths.includes("src/discovered.ts"));
});

test("returns no continuation path when context has no readable sources", () => {
  assert.deepEqual(resolveProposalPaths([], []), []);
});