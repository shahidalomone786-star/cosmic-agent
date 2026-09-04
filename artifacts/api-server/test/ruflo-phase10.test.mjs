import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const bundle = (source, output, format = "esm") => {
  execFileSync("pnpm", ["exec", "esbuild", source, "--bundle", "--platform=node", `--format=${format}`, "--external:pino", "--external:pino-pretty", `--outfile=${output}`], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
};

bundle("src/ruflo/ruflo-tool-registry.ts", "test-dist/ruflo-phase10-registry.mjs");
bundle("src/ruflo/ruflo-phase10-catalog.ts", "test-dist/ruflo-phase10-catalog.mjs");
bundle("src/ruflo/ruflo-runtime.ts", "test-dist/ruflo-phase10-runtime.cjs", "cjs");

const { createDefaultRufloToolRegistry } = await import("../test-dist/ruflo-phase10-registry.mjs");
const catalog = await import("../test-dist/ruflo-phase10-catalog.mjs");
const { createRufloToolExecutor } = await import("../test-dist/ruflo-phase10-runtime.cjs");

const policy = {
  permissions: ["repository:read", "workspace:read", "memory:read", "memory:write", "terminal:execute", "network:outbound"],
  allowLowRisk: false,
  approved: true,
};

test("registers a 300-plus unified executable Ruflo inventory with complete Phase 10 provenance", () => {
  const registry = createDefaultRufloToolRegistry();
  const tools = registry.list("ruflo");
  const enabled = tools.filter((tool) => tool.enabled);
  assert.ok(catalog.RUFLO_PHASE10_ORIGINAL_DECLARATION_COUNT >= 277);
  assert.ok(catalog.RUFLO_PHASE10_ADDITIONAL_PLUGIN_DECLARATION_COUNT >= 60);
  assert.ok(tools.length >= 340);
  assert.ok(enabled.length >= 300, `expected 300 executable tools, received ${enabled.length}`);
  for (const tool of catalog.RUFLO_PHASE10_TOOL_DEFINITIONS) {
    assert.equal(tool.provenance.license, "MIT");
    assert.equal(tool.provenance.originalRevision, catalog.RUFLO_PHASE10_ORIGINAL.revision);
    assert.ok(tool.provenance.sourcePath);
    assert.ok(tool.inputSchema);
    assert.ok(tool.permissions.length > 0);
    assert.ok(tool.resourceLimits.maxOutputBytes <= 32_000);
    assert.equal(tool.agentAccess.rufloOnly, true);
    if (tool.enabled) assert.notEqual(tool.executionAdapter, "disabled");
  }
});

test("keeps unsafe browser actions, federation, WASM, and transfer tools fail-closed", () => {
  const registry = createDefaultRufloToolRegistry();
  for (const id of ["browser_click", "browser_eval", "federation_bbs_publish", "wasm_agent_prompt", "transfer_plugin-search"]) {
    const definition = registry.get(id);
    assert.equal(definition.enabled, false, id);
    assert.throws(() => registry.authorize(id, {}, policy), (error) => error.code === "tool_disabled");
  }
  assert.equal(registry.get("browser_open").enabled, true);
  assert.equal(registry.get("terminal_execute").enabled, true);
});

test("executes adapted tools, writes audit traces, and bounds the result", async () => {
  const executor = createRufloToolExecutor();
  const result = await executor.execute({
    name: "aqe:security-scan",
    input: { text: "bounded repository evidence" },
    task: "phase 10 evidence adapter",
    sessionId: "phase10-test",
  });
  assert.equal(result.name, "aqe:security-scan");
  assert.equal(result.data.adapter, "bounded_evidence");
  assert.equal(result.data.license, "MIT");
  assert.ok(JSON.stringify(result).length < 32_000);
});

test("runs only the fixed-command terminal sandbox", async () => {
  const executor = createRufloToolExecutor();
  const workspace = { userId: "phase10-user", projectId: "phase10-terminal" };
  const created = await executor.execute({ name: "terminal_create", input: {}, task: "create terminal", workspace, approved: true });
  assert.equal(created.data.status, "ready");
  const result = await executor.execute({
    name: "terminal_execute",
    input: { command: "pwd", args: [] },
    task: "run bounded terminal command",
    workspace,
    approved: true,
  });
  assert.equal(result.data.exitCode, 0);
  await assert.rejects(
    executor.execute({
      name: "terminal_execute",
      input: { command: "sh", args: ["-c", "echo unsafe"] },
      task: "reject shell",
      workspace,
      approved: true,
    }),
    /allowlist|fixed Ruflo terminal|allowed value/i,
  );
});

test("blocks private-network browser targets before fetch", async () => {
  const executor = createRufloToolExecutor();
  await assert.rejects(
    executor.execute({
      name: "browser_open",
      input: { url: "https://127.0.0.1/", sessionId: "phase10-browser" },
      task: "test SSRF boundary",
      approved: true,
    }),
    /Private|local|reserved/i,
  );
});