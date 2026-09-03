import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const bundle = (source, output, format = "esm") => {
  if (!existsSync(output)) {
    execFileSync("pnpm", ["exec", "esbuild", source, "--bundle", "--platform=node", `--format=${format}`, "--external:pino", "--external:pino-pretty", `--outfile=${output}`], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
  }
};

bundle("src/ruflo/ruflo-tool-registry.ts", "test-dist/ruflo-phase9-registry.mjs");
bundle("src/ruflo/ruflo-phase9-catalog.ts", "test-dist/ruflo-phase9-catalog.mjs");
bundle("src/ruflo/ruflo-runtime.ts", "test-dist/ruflo-phase9-runtime.cjs", "cjs");
bundle("test/ruflo-swarm-entry.mjs", "test-dist/ruflo-phase9-swarm.mjs");

const { createDefaultRufloToolRegistry } = await import("../test-dist/ruflo-phase9-registry.mjs");
const catalog = await import("../test-dist/ruflo-phase9-catalog.mjs");
const { createRufloToolExecutor } = await import("../test-dist/ruflo-phase9-runtime.cjs");
const { InMemoryRufloSwarmRepository, RufloSwarmService } = await import("../test-dist/ruflo-phase9-swarm.mjs");

test("registers the compatible Phase 9 tools with provenance and Ruflo-only access", () => {
  const registry = createDefaultRufloToolRegistry();
  const ids = registry.list("ruflo").map((tool) => tool.id);
  assert.equal(ids.length, 11);
  assert.ok(ids.includes("memory_search"));
  assert.ok(ids.includes("guidance_capabilities"));
  const memory = registry.get("memory_search");
  assert.equal(memory.provenance.originalRevision, catalog.RUFLO_PHASE9_ORIGINAL.revision);
  assert.equal(memory.provenance.license, "MIT");
  assert.equal(memory.provenance.reuseMode, "adapted");
  assert.equal(memory.agentAccess.rufloOnly, true);
  assert.deepEqual(memory.resourceLimits.maxResults, 24);
});

test("keeps approval and schema controls on adapted memory tools", () => {
  const registry = createDefaultRufloToolRegistry();
  assert.throws(
    () => registry.authorize("memory_store", { fact: "safe", kind: "project_fact" }, {
      permissions: ["workspace:read", "memory:read", "memory:write"],
      allowLowRisk: false,
      approved: false,
    }),
    (error) => error.code === "approval_required",
  );
  assert.throws(
    () => registry.authorize("memory_search", { query: "" }, {
      permissions: ["workspace:read", "memory:read"],
      allowLowRisk: true,
      approved: false,
    }),
    (error) => error.code === "schema_invalid",
  );
});

test("executes a safe adapted system tool through the existing bounded executor", async () => {
  const executor = createRufloToolExecutor();
  const result = await executor.execute({ name: "system_info", input: {}, task: "catalog health check", sessionId: "phase9-test" });
  assert.equal(result.name, "system_info");
  assert.equal(result.data.phase, 9);
  assert.equal(result.data.originalRevision, catalog.RUFLO_PHASE9_ORIGINAL.revision);
});

test("keeps authority-heavy original tools explicitly disabled", () => {
  assert.equal(catalog.RUFLO_PHASE9_EXCLUDED_TOOL_COUNT, 7);
  assert.ok(catalog.RUFLO_PHASE9_EXCLUDED_TOOL_DEFINITIONS.every((tool) => tool.availability === "disabled" && tool.enabled === false));
  assert.ok(catalog.RUFLO_PHASE9_EXCLUDED_TOOL_DEFINITIONS.some((tool) => tool.id === "terminal_execute"));
  assert.ok(catalog.RUFLO_PHASE9_EXCLUDED_TOOL_DEFINITIONS.some((tool) => tool.id === "federation_bbs_publish"));
});

test("registers imported agent types into the existing authenticated Phase 8 capability map", async () => {
  let current = new Date("2026-09-03T00:00:00.000Z");
  const service = new RufloSwarmService(new InMemoryRufloSwarmRepository(), "phase9-test-signing-secret", () => current);
  const created = await service.createSwarm("user-a", { sessionId: "session-a", projectId: "project-a" });
  const security = await service.registerAgent("user-a", created.swarm.id, { agentId: created.leader.id, credential: created.credential }, {
    name: "security-auditor",
    type: "security-auditor",
  });
  assert.ok(security.agent.capabilities.includes("context:read"));
  assert.ok(security.agent.capabilities.includes("consensus:vote"));
  assert.equal(security.agent.capabilities.includes("agent:spawn"), false);
  current = new Date(current.getTime() + 1);
});

test("does not expose imported tools or agents as Normal Agent capabilities", () => {
  assert.equal(catalog.RUFLO_PHASE9_IMPORTED_AGENTS.every((agent) => agent.rufloOnly === true), true);
  assert.equal(catalog.RUFLO_PHASE9_IMPORTED_TOOLS.every((tool) => tool.agentAccess.rufloOnly === true), true);
});