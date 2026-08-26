import test from "node:test";
import assert from "node:assert/strict";
import { assertSafePush, assertSafeRepositoryPath, redactGitSensitive } from "../test-dist/git-security.mjs";
import { assertApproval, approveProposal } from "../test-dist/approval-gate.mjs";

const repository = { id: "1", owner: "owner", name: "repo", branch: "main", defaultBranch: "main", webUrl: "https://github.com/owner/repo" };
const proposal = {
  proposalId: "git-security-proposal",
  status: "proposal",
  summary: "safe change",
  explanation: "safe",
  risk: "LOW",
  affectedFiles: ["artifacts/cosmos/src/features/game-store/monetagGameAds.ts"],
  addedLines: 1,
  removedLines: 1,
  files: [{ path: "artifacts/cosmos/src/features/game-store/monetagGameAds.ts", operation: "edit", language: "typescript", originalCode: "before", proposedCode: "after", diff: "-before\n+after", explanation: "safe", addedLines: 1, removedLines: 1 }],
};

test("arbitrary shell execution is not represented by the controlled Git surface", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/repository/github-write-provider.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /\b(exec|spawn|execFile|shell)\b/);
});

test("repository paths are confined and protected paths are rejected", () => {
  assert.equal(assertSafeRepositoryPath("artifacts/cosmos/src/features/game-store/monetagGameAds.ts"), "artifacts/cosmos/src/features/game-store/monetagGameAds.ts");
  for (const path of ["../../etc/passwd", "/tmp/file", ".env", ".git/config", "node_modules/a"]) assert.throws(() => assertSafeRepositoryPath(path));
});

test("force push and unrelated branches are rejected", () => {
  assert.throws(() => assertSafePush("main", "main", true));
  assert.throws(() => assertSafePush("other", "main"));
  assert.doesNotThrow(() => assertSafePush("main", "main", false));
});

test("unapproved changes cannot be committed or pushed", () => {
  const apply = approveProposal(proposal, repository, "user-a", undefined, "apply");
  assert.throws(() => assertApproval(apply.approvalId, proposal, repository, undefined, "commit"), /authorize|approval/i);
  assert.throws(() => assertApproval(apply.approvalId, proposal, repository, undefined, "push"), /authorize|approval/i);
  assert.doesNotThrow(() => assertApproval(apply.approvalId, proposal, repository, undefined, "apply"));
});

test("credential-shaped values are redacted before traces or results", () => {
  const safe = redactGitSensitive("Authorization: Bearer ghp_secret_value");
  assert.doesNotMatch(safe, /ghp_secret_value/);
  assert.match(safe, /\[redacted\]/);
});