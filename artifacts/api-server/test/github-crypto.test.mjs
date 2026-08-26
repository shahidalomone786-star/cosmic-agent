import test from "node:test";
import assert from "node:assert/strict";
import { decryptGitHubToken, encryptGitHubToken } from "../test-dist/github-crypto.mjs";

test("GitHub tokens are encrypted with authenticated encryption and never stored raw", () => {
  process.env.SESSION_SECRET = "test-only-session-secret";
  const raw = "ghp_test_token_that_must_not_be_stored";
  const encrypted = encryptGitHubToken(raw);
  assert.notEqual(encrypted.encryptedToken, raw);
  assert.equal(decryptGitHubToken(encrypted.encryptedToken, encrypted.nonce, encrypted.authTag), raw);
  assert.throws(() => decryptGitHubToken(encrypted.encryptedToken.slice(1), encrypted.nonce, encrypted.authTag));
});