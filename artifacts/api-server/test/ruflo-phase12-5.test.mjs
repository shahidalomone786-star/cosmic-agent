import test from "node:test";
import assert from "node:assert/strict";
import { buildControlCenterSnapshot } from "../test-dist/ruflo-control-center.mjs";

const snapshot = (overrides = {}) => buildControlCenterSnapshot({
  github: { status: "not_connected", lastValidatedAt: null },
  tools: [
    { enabled: true, availability: "available" },
    { enabled: false, availability: "disabled" },
  ],
  auditRecords: [
    { executionStatus: "completed", toolId: "read_file", riskLevel: "low", approvalStatus: "not_required", timestamp: "2026-09-06T08:00:00.000Z" },
  ],
  models: [{ enabled: true }, { enabled: false }],
  now: () => new Date("2026-09-06T08:30:00.000Z"),
  ...overrides,
});

test("declares the exact Phase 12.5 category and module order", () => {
  const result = snapshot();
  assert.deepEqual(result.categories.map((category) => category.label), [
    "DEVELOPMENT",
    "SOURCE CONTROL",
    "DATA & INTEGRATIONS",
    "SECURITY",
    "ACCOUNT",
  ]);
  assert.deepEqual(result.categories.map((category) => category.modules.map((module) => module.id)), [
    ["skills", "files", "console", "workflows"],
    ["git", "changes", "history"],
    ["database", "storage", "integrations"],
    ["secrets", "permissions", "audit", "security-center"],
    ["users-auth"],
  ]);
});

test("keeps intentionally restricted surfaces disabled with truthful reasons", () => {
  const result = snapshot();
  const modules = result.categories.flatMap((category) => category.modules);
  for (const id of ["console", "database", "storage", "security-center"]) {
    const module = modules.find((candidate) => candidate.id === id);
    assert.equal(module.classification, "DISABLED — INTENTIONALLY RESTRICTED");
    assert.match(module.reason, /safe|contract|configured|live scan/i);
    assert.equal(module.status, "restricted");
  }
});

test("keeps Git read-only and never returns credential material", () => {
  const result = snapshot({
    github: { status: "connected", lastValidatedAt: new Date("2026-09-06T08:20:00.000Z") },
  });
  const modules = result.categories.flatMap((category) => category.modules);
  const git = modules.find((module) => module.id === "git");
  const integrations = modules.find((module) => module.id === "integrations");
  const serialized = JSON.stringify(result);
  assert.match(git.reason, /no commit, push, reset, rebase, or rewrite operation/i);
  assert.match(git.diagnostics.join(" "), /Protected Git write routes remain outside this UI/i);
  assert.equal(integrations.status, "verified");
  assert.doesNotMatch(serialized, /ghp_|github_pat_|token|secret_value/i);
});

test("bounds activity to the current server-provided records and preserves status", () => {
  const result = snapshot({
    auditRecords: Array.from({ length: 12 }, (_, index) => ({
      executionStatus: index === 0 ? "failed" : "completed",
      toolId: `tool_${index}`,
      riskLevel: "low",
      approvalStatus: "not_required",
      timestamp: `2026-09-06T08:${String(index).padStart(2, "0")}:00.000Z`,
    })),
  });
  assert.equal(result.activity.length, 8);
  assert.equal(result.overallStatus, "operational");
  assert.equal(result.activity[0].label, "Tool completed");
});