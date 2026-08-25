import test from "node:test";
import assert from "node:assert/strict";
import { classifyGitHubCredentialStatus, classifyGitHubResponse, parseGitHubUrl } from "../test-dist/github-response.mjs";

test("accepts canonical GitHub repository URLs only", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/shahidalomone786-star/cosmic-ocean-v2"), {
    owner: "shahidalomone786-star",
    name: "cosmic-ocean-v2",
  });
  assert.deepEqual(parseGitHubUrl("https://github.com/owner/repository.git"), {
    owner: "owner",
    name: "repository",
  });
  assert.throws(() => parseGitHubUrl("https://github.com/owner/repository/tree/main"), /Invalid repository URL/);
  assert.throws(() => parseGitHubUrl("https://example.com/owner/repository"), /Invalid repository URL/);
});

test("distinguishes GitHub JSON 404 from an internal HTML fallback", () => {
  assert.equal(classifyGitHubResponse(404, "application/json", '{"message":"Not Found"}', { message: "Not Found" }), "file_not_found");
  assert.equal(classifyGitHubResponse(404, "text/html", "<!doctype html><title>Run this app</title>", null), "internal_route");
  assert.equal(classifyGitHubResponse(403, "application/json", '{"message":"API rate limit exceeded"}', { message: "API rate limit exceeded" }), "rate_limited");
  assert.equal(classifyGitHubResponse(400, "application/json", '{"message":"Bad request"}', { message: "Bad request" }), "network");
});

test("maps mocked GitHub credential responses to safe connection statuses", () => {
  assert.equal(classifyGitHubCredentialStatus(200, "application/json", '{"login":"cosmic"}', { login: "cosmic" }), "connected");
  assert.equal(classifyGitHubCredentialStatus(401, "application/json", '{"message":"Bad credentials"}', { message: "Bad credentials" }), "invalid");
  assert.equal(classifyGitHubCredentialStatus(403, "application/json", '{"message":"API rate limit exceeded"}', { message: "API rate limit exceeded" }), "rate_limited");
  assert.equal(classifyGitHubCredentialStatus(429, "application/json", '{"message":"Too many requests"}', { message: "Too many requests" }), "rate_limited");
  assert.equal(classifyGitHubCredentialStatus(503, "application/json", '{"message":"Service unavailable"}', { message: "Service unavailable" }), "unavailable");
  assert.equal(classifyGitHubCredentialStatus(0, "", "", null), "unavailable");
});