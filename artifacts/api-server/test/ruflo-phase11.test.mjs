import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const bundle = (source, output, format = "esm") => {
  execFileSync("pnpm", [
    "exec", "esbuild", source, "--bundle", "--platform=node", `--format=${format}`,
    "--external:pino", "--external:pino-pretty", `--outfile=${output}`,
  ], { cwd: process.cwd(), stdio: "ignore" });
};

bundle("src/ruflo/ruflo-tool-registry.ts", "test-dist/ruflo-phase11-registry.mjs");
bundle("src/ruflo/ruflo-runtime.ts", "test-dist/ruflo-phase11-runtime.cjs", "cjs");

const { createDefaultRufloToolRegistry } = await import("../test-dist/ruflo-phase11-registry.mjs");
const { createRufloToolExecutor, listRufloAuditRecords } = await import("../test-dist/ruflo-phase11-runtime.cjs");

const policyPermissions = [
  "repository:read", "workspace:read", "memory:read", "memory:write",
  "terminal:execute", "network:outbound",
];

test("classifies every registered tool and keeps native claims narrow", () => {
  const registry = createDefaultRufloToolRegistry();
  const tools = registry.list("ruflo");
  const native = tools.filter((tool) => tool.implementationKind === "native");
  const adapters = tools.filter((tool) => tool.implementationKind === "cosmic-adapter");
  const disabled = tools.filter((tool) => tool.implementationKind === "disabled");
  const metadata = tools.filter((tool) => tool.implementationKind === "metadata-only");

  assert.deepEqual(native.map((tool) => tool.id).sort(), [
    "mcp_status",
    "system_health",
    "system_info",
    "system_metrics",
    "system_status",
    "task_summary",
    "workflow_validate",
  ]);
  assert.ok(adapters.length > 0);
  assert.ok(disabled.length > 0);
  assert.ok(metadata.length > 0);
  for (const tool of tools) {
    assert.ok(tool.originalSource);
    assert.ok(tool.originalRevision);
    assert.ok(tool.originalBehaviorReference);
    assert.ok(tool.cosmicImplementation);
    assert.ok(tool.executionMode);
    assert.ok(tool.testStatus);
    assert.ok(tool.parityStatus);
    assert.ok(tool.resourceLimits);
  }
  for (const tool of native) {
    assert.equal(tool.testStatus, "verified");
    assert.equal(tool.executionAdapter, "native");
    assert.equal(tool.provenance.reuseMode, "native");
    assert.equal(tool.provenance.originalRevision, "db4991967c45c6f72133dff0bb80b0a492960fc1");
  }
});

test("executes native system behavior with bounded output and no network probe", async () => {
  const executor = createRufloToolExecutor();
  const info = await executor.execute({
    name: "system_info",
    input: {},
    task: "phase 11 native system info",
    sessionId: "phase11-system",
    requestId: "req-system-info",
  });
  assert.equal(info.data.features.browser, "public_https_read_only");
  assert.equal(info.data.limits.maxAgents, 5);

  const metrics = await executor.execute({
    name: "system_metrics",
    input: { category: "memory" },
    task: "phase 11 native metrics",
    sessionId: "phase11-system",
    requestId: "req-system-metrics",
  });
  assert.equal(typeof metrics.data.heapUsed, "number");

  const health = await executor.execute({
    name: "system_health",
    input: { deep: true },
    task: "phase 11 native health",
    sessionId: "phase11-system",
    requestId: "req-system-health",
  });
  assert.equal(health.data.checks.find((check) => check.name === "network").status, "not_checked");
  assert.ok(JSON.stringify(health).length < 24_000);
});

test("enforces schemas, input limits, and correlated redacted audit records", async () => {
  const executor = createRufloToolExecutor();
  await assert.rejects(
    executor.execute({ name: "system_metrics", input: { category: "invalid" }, task: "bad schema" }),
    /schema_invalid|invalid|not an allowed/i,
  );
  await assert.rejects(
    executor.execute({
      name: "system_info",
      input: { include: Array.from({ length: 12 }, () => "x".repeat(800)) },
      task: "large bounded input",
    }),
    /resource limit|exceeds/i,
  );

  await executor.execute({
    name: "system_status",
    input: { verbose: true },
    task: "audit correlation",
    sessionId: "phase11-audit",
    userId: "phase11-user",
    agentId: "agent-phase11",
    jobId: "job-phase11",
    requestId: "req-phase11",
  });
  const records = listRufloAuditRecords({ sessionId: "phase11-audit" });
  const completed = records.find((record) => record.executionStatus === "completed");
  assert.equal(completed.requestId, "req-phase11");
  assert.equal(completed.agentId, "agent-phase11");
  assert.equal(completed.jobId, "job-phase11");
  assert.equal(completed.implementationKind, "native");
  assert.equal(completed.sourceRevision, "db4991967c45c6f72133dff0bb80b0a492960fc1");
});

test("keeps unsafe authority surfaces disabled", () => {
  const registry = createDefaultRufloToolRegistry();
  for (const id of [
    "browser_click", "browser_eval", "federation_bbs_publish",
    "wasm_agent_prompt", "transfer_plugin-search", "agent_spawn",
  ]) {
    const definition = registry.get(id);
    assert.equal(definition.enabled, false, id);
    assert.ok(["disabled", "metadata-only"].includes(definition.implementationKind), id);
    assert.throws(
      () => registry.authorize(id, {}, {
        permissions: policyPermissions,
        allowLowRisk: true,
        approved: true,
      }),
      (error) => error.code === "tool_disabled",
    );
  }
});

test("rejects workflow validation without an authorized source", async () => {
  const executor = createRufloToolExecutor();
  await assert.rejects(
    executor.execute({
      name: "workflow_validate",
      input: { file: "workflow.json" },
      task: "validate workflow without source",
    }),
    /connected repository or workspace/i,
  );
});

test("runs the two safe agentic-QE adapters without code execution or network access", async () => {
  const executor = createRufloToolExecutor();
  const text = "const token = 'ghp_123456789012345678901234';\nconst x = eval(input);";
  const secrets = await executor.execute({
    name: "aqe:detect-secrets",
    input: { text },
    task: "safe secret scan",
    requestId: "req-secret-scan",
  });
  assert.equal(secrets.data.adapter, "safe_plugin");
  assert.equal(secrets.data.networkAccess, false);
  assert.equal(secrets.data.executedCode, false);
  assert.equal(secrets.data.findings[0].redactedMatch, "[redacted]");

  const security = await executor.execute({
    name: "aqe:security-scan",
    input: { text, includeDependencies: true },
    task: "safe security scan",
    requestId: "req-security-scan",
  });
  assert.ok(security.data.findings.some((finding) => finding.ruleId === "unsafe-execution-pattern"));
});
