import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRemoteHeadMatches,
  classifyGitHubWriteFailure,
  resolveRepositoryWritePermission,
} from "../test-dist/github-write-policy.mjs";
import { redactGitSensitive } from "../test-dist/git-security.mjs";

const repository = { id: "1", owner: "owner", name: "repo", branch: "main", defaultBranch: "main", webUrl: "https://github.com/owner/repo" };

test("permission checks allow push/admin and reject pull-only access", () => {
  assert.equal(resolveRepositoryWritePermission(repository, "main", "head-1", { push: true }).permission, "push");
  assert.equal(resolveRepositoryWritePermission(repository, "main", "head-1", { admin: true }).permission, "admin");
  assert.throws(
    () => resolveRepositoryWritePermission(repository, "main", "head-1", { pull: true }),
    (error) => error.code === "permission_denied" && /cannot push/.test(error.message),
  );
});

test("invalid credentials become a clean authorization error without token leakage", () => {
  const failure = classifyGitHubWriteFailure(401, "Bad credentials: github_pat_secret-value");
  assert.equal(failure.code, "invalid_credential");
  assert.match(failure.message, /invalid or expired/i);
  assert.doesNotMatch(failure.message, /secret-value/);
});

test("GitHub errors preserve conflict and permission boundaries", () => {
  assert.equal(classifyGitHubWriteFailure(403, "Resource not accessible by integration").code, "permission_denied");
  assert.equal(classifyGitHubWriteFailure(409, "Head changed").code, "conflict");
  assert.equal(classifyGitHubWriteFailure(403, "API rate limit exceeded", "0").code, "provider_not_configured");
});

test("credential values and modern GitHub token forms are redacted", () => {
  const exact = "server-held-token-value";
  const safe = redactGitSensitive(`Bearer github_pat_abc123 ${exact}`, [exact]);
  assert.doesNotMatch(safe, /github_pat_abc123|server-held-token-value/);
  assert.match(safe, /\[redacted\]/);
});

test("push success requires remote branch HEAD verification", () => {
  assert.doesNotThrow(() => assertRemoteHeadMatches("commit-1", "commit-1"));
  assert.throws(
    () => assertRemoteHeadMatches("commit-1", "commit-2"),
    (error) => error.code === "verification_failed" && /No push success/.test(error.message),
  );
});