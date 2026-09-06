import type { RufloJsonSchema, RufloRiskLevel, RufloToolPermission, RufloUnifiedToolDefinition } from "./ruflo-tool-registry";

/**
 * Phase 10 imports the audited tool names from the MIT Ruflo revision without
 * copying its process, network, credential, or model-runtime authority.
 *
 * The original implementations are adapted to the server-owned executor. A
 * definition is only enabled when its adapter has a bounded execution path;
 * the rest remain explicit disabled provenance records.
 */
export const RUFLO_PHASE10_ORIGINAL = {
  repository: "https://github.com/ruvnet/ruflo",
  revision: "db4991967c45c6f72133dff0bb80b0a492960fc1",
  license: "MIT",
  licenseCopyright: "Copyright (c) 2024-2026 ruvnet",
} as const;

export type RufloPhase10ReuseMode = "adapted" | "metadata_only";
export type RufloPhase10Availability = "enabled" | "disabled";
export type RufloPhase10ExecutionAdapter = "bounded_evidence" | "sandboxed_terminal" | "safe_browser" | "disabled";

export type RufloPhase10ToolSpec = RufloUnifiedToolDefinition & {
  originalName: string;
  executionAdapter: RufloPhase10ExecutionAdapter;
  provenance: NonNullable<RufloUnifiedToolDefinition["provenance"]>;
  agentAccess: NonNullable<RufloUnifiedToolDefinition["agentAccess"]>;
  resourceLimits: NonNullable<RufloUnifiedToolDefinition["resourceLimits"]>;
  availability: RufloPhase10Availability;
};

const boundedText: RufloJsonSchema = { type: "string", minLength: 1, maxLength: 1_000 };
const optionalText: RufloJsonSchema = { type: "string", maxLength: 1_000 };
const inputSchema: RufloJsonSchema = {
  type: "object",
  properties: {
    query: optionalText,
    path: { type: "string", maxLength: 500 },
    text: { type: "string", maxLength: 8_000 },
    url: { type: "string", maxLength: 2_000 },
    sessionId: { type: "string", maxLength: 120 },
    projectKey: { type: "string", maxLength: 300 },
    limit: { type: "integer", maxItems: 48 },
  },
  additionalProperties: false,
};

const outputSchema: RufloJsonSchema = { type: "object", additionalProperties: true };
const resourceLimits = {
  maxInputBytes: 12_000,
  maxOutputBytes: 32_000,
  maxResults: 48,
  maxConcurrentCalls: 2,
} as const;
const memoryResourceLimits = {
  maxInputBytes: 12_000,
  maxOutputBytes: 24_000,
  maxResults: 24,
  maxConcurrentCalls: 1,
} as const;
const allowedAgentTypes = [
  "coordinator",
  "planner",
  "coder",
  "reviewer",
  "validator",
  "tester",
  "researcher",
  "security-auditor",
  "memory-specialist",
  "git-specialist",
  "docs-writer",
  "workflow-specialist",
  "intelligence-specialist",
  "browser-agent",
  "sparc-orchestrator",
];

const originalToolNames = `
agent_spawn
agent_execute
agent_terminate
agent_status
agent_list
agent_pool
agent_health
agent_update
agent_logs
federation_bbs_register
federation_bbs_publish
federation_bbs_watch
federation_bbs_human_join
agenticow_speculate
agenticow_branch
agenticow_ingest
agenticow_query
agenticow_diff
agenticow_lineage
agenticow_status
agenticow_checkpoint
agenticow_rollback
agenticow_promote
browser_act
browser_session_record
browser_session_end
browser_session_replay
browser_template_apply
browser_cookie_use
browser_open
browser_back
browser_forward
browser_reload
browser_close
browser_snapshot
browser_screenshot
browser_click
browser_fill
browser_type
browser_press
browser_hover
browser_select
browser_check
browser_uncheck
browser_scroll
browser_get-text
browser_get-value
browser_get-title
browser_get-url
browser_wait
browser_eval
browser_session-list
business_pod_validate
business_pod_route_backend
claims_claim
claims_release
claims_handoff
claims_accept-handoff
claims_status
claims_list
claims_mark-stealable
claims_steal
claims_stealable
claims_load
claims_board
claims_rebalance
config_get
config_set
config_list
config_reset
config_export
config_import
coordination_topology
coordination_load_balance
coordination_sync
coordination_node
coordination_consensus
coordination_orchestrate
coordination_metrics
daa_agent_create
daa_agent_adapt
daa_workflow_create
daa_workflow_execute
daa_knowledge_share
daa_learning_status
daa_cognitive_pattern
daa_performance_metrics
embeddings_init
embeddings_generate
embeddings_compare
embeddings_search
embeddings_neural
embeddings_hyperbolic
embeddings_status
embeddings_rabitq_build
embeddings_rabitq_search
embeddings_rabitq_status
github_repo_analyze
github_pr_manage
github_issue_track
github_workflow
github_metrics
hive-mind_spawn
hive-mind_init
hive-mind_status
hive-mind_join
hive-mind_leave
hive-mind_consensus
hive-mind_broadcast
hive-mind_shutdown
hive-mind_memory
hive-mind_optimize-memory
http_fetch
managed_agent_create
managed_agent_prompt
managed_agent_status
managed_agent_events
managed_agent_list
managed_agent_terminate
memory_store
memory_retrieve
memory_search
memory_delete
memory_list
memory_stats
memory_migrate
memory_import_claude
memory_bridge_status
memory_search_unified
memory_detailed-stats
memory_cleanup
memory_compress
memory_export
memory_import
metaharness_score
metaharness_genome
metaharness_mcp_scan
metaharness_threat_model
metaharness_oia_audit
metaharness_audit_list
metaharness_similarity
metaharness_drift_from_history
metaharness_audit_trend
metaharness_evolve
metaharness_security_bench
metaharness_bench
metaharness_redblue
metaharness_learn
metaharness_gepa
metaharness_flywheel
neural_train
neural_predict
neural_patterns
neural_compress
neural_status
neural_optimize
performance_report
performance_bottleneck
performance_benchmark
performance_profile
performance_optimize
performance_metrics
policy_evaluate
policy_status
policy_rule_upsert
policy_budget_set
policy_approve
policy_revoke
ruvllm_status
ruvllm_hnsw_create
ruvllm_hnsw_add
ruvllm_hnsw_route
ruvllm_sona_create
ruvllm_sona_adapt
ruvllm_microlora_create
ruvllm_microlora_adapt
ruvllm_chat_format
ruvllm_generate_config
session_save
session_restore
session_list
session_delete
session_info
session_current
session_export
session_import
swarm_init
swarm_pheromone_update
swarm_pheromone_status
swarm_status
swarm_shutdown
swarm_health
coordinator
agents
persistence
topology
system_status
system_metrics
system_health
memory
config
mcp
swarm
neural
disk
network
database
system_info
system_reset
mcp_status
task_summary
mcp_start
mcp_stop
task_create
task_status
task_list
task_complete
task_update
task_assign
task_cancel
task_retry
terminal_create
terminal_execute
terminal_list
terminal_close
terminal_history
testgen_tdd_repair
transfer_detect-pii
transfer_ipfs-resolve
transfer_store-search
transfer_store-info
transfer_store-download
transfer_store-featured
transfer_store-trending
transfer_plugin-search
transfer_plugin-info
transfer_plugin-featured
transfer_plugin-official
wasm_agent_create
wasm_agent_prompt
wasm_agent_tool
wasm_agent_list
wasm_agent_terminate
wasm_agent_files
wasm_agent_export
wasm_gallery_list
wasm_gallery_search
wasm_gallery_create
wasm_agent_compose
wasm_agent_state
wasm_agent_todos
wasm_agent_tools
wasm_agent_turn_count
wasm_agent_is_stopped
wasm_agent_reset
wasm_gallery_load_rvf
wasm_gallery_configure
wasm_gallery_categories
wasm_gallery_list_by_category
wasm_gallery_add_custom
wasm_gallery_remove_custom
wasm_gallery_import
wasm_gallery_export
wasm_gallery_active
wasm_gallery_config
workflow_run
workflow_create
workflow_execute
workflow_status
workflow_list
workflow_pause
workflow_resume
workflow_cancel
workflow_delete
workflow_template
workflow_stop
workflow_validate
`.trim().split(/\s+/);

const additionalPluginTools: Array<{ id: string; originalName: string; sourcePath: string }> = [
  ...[
    "generate-tests", "tdd-cycle", "suggest-tests", "analyze-coverage", "prioritize-gaps",
    "track-trends", "evaluate-quality-gate", "assess-readiness", "calculate-risk",
    "predict-defects", "analyze-root-cause", "find-similar-defects", "security-scan",
    "audit-compliance", "detect-secrets",
  ].map((name) => ({ id: `aqe:${name}`, originalName: `aqe/${name}`, sourcePath: "v3/plugins/agentic-qe/src/tools/index.ts" })),
  ...[
    "bottleneck-detect", "memory-analyze", "query-optimize", "bundle-optimize", "config-optimize",
  ].map((name) => ({ id: `perf:${name}`, originalName: `perf/${name}`, sourcePath: "v3/plugins/perf-optimizer/src/mcp-tools.ts" })),
  ...[
    "select-predictive", "flaky-detect", "coverage-gaps", "mutation-optimize", "generate-suggest",
  ].map((name) => ({ id: `test:${name}`, originalName: `test/${name}`, sourcePath: "v3/plugins/test-intelligence/src/mcp-tools.ts" })),
  ...[
    "semantic-search", "architecture-analyze", "refactor-impact", "split-suggest", "learn-patterns",
  ].map((name) => ({ id: `code:${name}`, originalName: `code/${name}`, sourcePath: "v3/plugins/code-intelligence/src/mcp-tools.ts" })),
  ...[
    "neural-consensus", "topology-optimize", "collective-memory", "emergent-protocol", "swarm-behavior",
  ].map((name) => ({ id: `coordination:${name}`, originalName: `coordination/${name}`, sourcePath: "v3/plugins/neural-coordination/src/mcp-tools.ts" })),
  ...[
    "embed-hierarchy", "taxonomic-reason", "semantic-search", "hierarchy-compare", "entailment-graph",
  ].map((name) => ({ id: `hyperbolic:${name}`, originalName: `hyperbolic_${name}`, sourcePath: "v3/plugins/hyperbolic-reasoning/src/mcp-tools.ts" })),
  ...[
    "annealing-solve", "qaoa-optimize", "grover-search", "dependency-resolve", "schedule-optimize",
  ].map((name) => ({ id: `quantum:${name}`, originalName: `quantum_${name}`, sourcePath: "v3/plugins/quantum-optimizer/src/mcp-tools.ts" })),
  ...[
    "working-memory", "attention-control", "meta-monitor", "scaffold", "cognitive-load",
  ].map((name) => ({ id: `cognition:${name}`, originalName: `cognition/${name}`, sourcePath: "v3/plugins/cognitive-kernel/src/mcp-tools.ts" })),
  ...[
    "clause-extract", "risk-assess", "contract-compare", "obligation-track", "playbook-match",
  ].map((name) => ({ id: `legal:${name}`, originalName: `legal/${name}`, sourcePath: "v3/plugins/legal-contracts/src/mcp-tools.ts" })),
  ...[
    "pr_coherence_check", "pr_spectral_analyze", "pr_causal_infer",
    "pr_consensus_verify", "pr_quantum_topology", "pr_memory_gate",
  ].map((id) => ({ id, originalName: id, sourcePath: `v3/plugins/prime-radiant/src/tools/${id.replace("pr_", "").replaceAll("_", "-")}.ts` })),
  ...[
    "page-rank-entry", "solve", "solve-on-change", "analyze", "feasibility", "jl-embed",
  ].map((name) => ({ id: `sublinear:${name}`, originalName: `sublinear/${name}`, sourcePath: "plugins/ruflo-graph-intelligence/src/mcp-tools/index.ts" })),
  ...[
    "discover_teams", "get_status", "get_topology_stats", "find_optimal_path", "route_task",
    "batch_route",
  ].map((name) => ({ id: `teammate:${name}`, originalName: `teammate_${name}`, sourcePath: "v3/plugins/teammate-plugin/src/mcp-tools.ts" })),
  ...[
    "beads_ready", "beads_show", "convoy_status", "convoy_track", "formula_list", "agents",
  ].map((name) => ({ id: `gt:${name}`, originalName: `gt_${name}`, sourcePath: "v3/plugins/gastown-bridge/src/mcp-tools.ts" })),
  ...[
    "portfolio-risk", "anomaly-detect", "market-regime", "compliance-check", "stress-test",
  ].map((name) => ({ id: `finance:${name}`, originalName: `finance/${name}`, sourcePath: "v3/plugins/financial-risk/src/mcp-tools.ts" })),
  ...[
    "patient-similarity", "drug-interactions", "clinical-pathways", "literature-search", "ontology-navigate",
  ].map((name) => ({ id: `healthcare:${name}`, originalName: `healthcare/${name}`, sourcePath: "v3/plugins/healthcare-clinical/src/mcp-tools.ts" })),
  ...[
    "beads-dep", "wasm-match-pattern",
  ].map((name) => ({ id: `gt:${name}`, originalName: `gt_${name.replaceAll("-", "_")}`, sourcePath: "v3/plugins/gastown-bridge/src/mcp-tools.ts" })),
];

const sourcePaths: Record<string, string> = {
  agent_: "v3/@claude-flow/cli/src/mcp-tools/agent-tools.ts",
  federation_: "v3/@claude-flow/cli/src/mcp-tools/agentbbs-tools.ts",
  agenticow_: "v3/@claude-flow/cli/src/mcp-tools/agenticow-tools.ts",
  browser_: "v3/@claude-flow/cli/src/mcp-tools/browser-tools.ts",
  business_: "v3/@claude-flow/cli/src/mcp-tools/business-pod-tools.ts",
  claims_: "v3/@claude-flow/cli/src/mcp-tools/claims-tools.ts",
  config_: "v3/@claude-flow/cli/src/mcp-tools/config-tools.ts",
  coordination_: "v3/@claude-flow/cli/src/mcp-tools/coordination-tools.ts",
  daa_: "v3/@claude-flow/cli/src/mcp-tools/daa-tools.ts",
  embeddings_: "v3/@claude-flow/cli/src/mcp-tools/embeddings-tools.ts",
  github_: "v3/@claude-flow/cli/src/mcp-tools/github-tools.ts",
  "hive-mind_": "v3/@claude-flow/cli/src/mcp-tools/hive-mind-tools.ts",
  http_: "v3/@claude-flow/cli/src/mcp-tools/http-fetch-tools.ts",
  managed_: "v3/@claude-flow/cli/src/mcp-tools/managed-agent-tools.ts",
  memory_: "v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts",
  metaharness_: "v3/@claude-flow/cli/src/mcp-tools/metaharness-tools.ts",
  neural_: "v3/@claude-flow/cli/src/mcp-tools/neural-tools.ts",
  performance_: "v3/@claude-flow/cli/src/mcp-tools/performance-tools.ts",
  policy_: "v3/@claude-flow/cli/src/mcp-tools/policy-tools.ts",
  ruvllm_: "v3/@claude-flow/cli/src/mcp-tools/ruvllm-tools.ts",
  session_: "v3/@claude-flow/cli/src/mcp-tools/session-tools.ts",
  swarm_: "v3/@claude-flow/cli/src/mcp-tools/swarm-tools.ts",
  system_: "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
  task_: "v3/@claude-flow/cli/src/mcp-tools/task-tools.ts",
  terminal_: "v3/@claude-flow/cli/src/mcp-tools/terminal-tools.ts",
  testgen_: "v3/@claude-flow/cli/src/mcp-tools/testgen-tools.ts",
  transfer_: "v3/@claude-flow/cli/src/mcp-tools/transfer-tools.ts",
  wasm_: "v3/@claude-flow/cli/src/mcp-tools/wasm-agent-tools.ts",
  workflow_: "v3/@claude-flow/cli/src/mcp-tools/workflow-tools.ts",
};

const hardDisabled = new Map<string, string>([
  ["agent_spawn", "Agent spawning is server-held by the Phase 8 swarm; native process spawning is not imported."],
  ["agent_execute", "Native managed-agent execution would bypass the existing Phase 8 agent capability boundary."],
  ["agent_terminate", "Native agent termination is not available outside the authenticated Phase 8 swarm service."],
  ["agent_update", "Native agent mutation is not available outside the authenticated Phase 8 swarm service."],
  ["http_fetch", "Arbitrary HTTP fetching is disabled; only the public-HTTPS browser-lite adapter has an SSRF policy."],
  ["federation_bbs_register", "Cross-machine federation is excluded because no mTLS/peer-attestation service exists here."],
  ["federation_bbs_publish", "Cross-machine federation is excluded because no mTLS/peer-attestation service exists here."],
  ["federation_bbs_watch", "Cross-machine federation is excluded because no mTLS/peer-attestation service exists here."],
  ["federation_bbs_human_join", "Cross-machine federation is excluded because no mTLS/peer-attestation service exists here."],
  ["claims_claim", "Claim mutation requires the unavailable exclusive-claim persistence service."],
  ["claims_release", "Claim mutation requires the unavailable exclusive-claim persistence service."],
  ["claims_handoff", "Claim mutation requires the unavailable exclusive-claim persistence service."],
  ["claims_accept-handoff", "Claim mutation requires the unavailable exclusive-claim persistence service."],
  ["claims_mark-stealable", "Claim mutation requires the unavailable exclusive-claim persistence service."],
  ["claims_steal", "Claim mutation requires the unavailable exclusive-claim persistence service."],
  ["claims_rebalance", "Claim mutation requires the unavailable exclusive-claim persistence service."],
  ["hive-mind_spawn", "A second hive-mind authority is excluded; use the authenticated Phase 8 swarm."],
  ["hive-mind_init", "A second hive-mind authority is excluded; use the authenticated Phase 8 swarm."],
  ["hive-mind_join", "A second hive-mind authority is excluded; use the authenticated Phase 8 swarm."],
  ["hive-mind_leave", "A second hive-mind authority is excluded; use the authenticated Phase 8 swarm."],
  ["hive-mind_consensus", "A second hive-mind authority is excluded; use the authenticated Phase 8 swarm."],
  ["hive-mind_broadcast", "A second hive-mind authority is excluded; use the authenticated Phase 8 swarm."],
  ["hive-mind_shutdown", "A second hive-mind authority is excluded; use the authenticated Phase 8 swarm."],
]);

const hardDisabledPrefixes: Array<[string, string]> = [
  ["browser_", "Browser actions, cookies, evaluation, and arbitrary navigation require a full isolated browser service."],
  ["wasm_", "The original WASM runtime/gallery is unavailable and cannot be safely emulated by metadata."],
  ["transfer_", "Marketplace/IPFS/plugin transfer performs external effects not available in the server boundary."],
];

const enabledBrowserTools = new Set(["browser_open", "browser_snapshot", "browser_get-text", "browser_get-value", "browser_get-title", "browser_get-url", "browser_wait", "browser_session-list", "browser_back", "browser_forward", "browser_reload", "browser_close"]);
const phase9Names = new Set(["memory_search", "memory_store", "memory_cleanup", "memory_stats", "guidance_capabilities", "system_info", "system_health"]);

function sourcePathFor(id: string): string {
  const plugin = additionalPluginTools.find((tool) => tool.id === id);
  if (plugin) return plugin.sourcePath;
  const entry = Object.entries(sourcePaths).find(([prefix]) => id.startsWith(prefix));
  if (entry) return entry[1];
  if (id === "coordinator" || id === "agents" || id === "persistence" || id === "topology") return "v3/@claude-flow/cli/src/mcp-tools/swarm-tools.ts";
  if (["memory", "config", "mcp", "swarm", "neural", "disk", "network", "database", "mcp_status", "mcp_start", "mcp_stop"].includes(id)) return "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts";
  return "v3/@claude-flow/cli/src/mcp-tools/guidance-tools.ts";
}

function categoryFor(id: string): string {
  return id.includes(":") ? id.split(":")[0] : id.split(/[_-]/)[0] ?? "core";
}

function permissionsFor(id: string): RufloToolPermission[] {
  if (id.startsWith("browser_")) return ["network:outbound", "workspace:read"];
  if (id === "terminal_execute") return ["terminal:execute", "workspace:read"];
  if (id.startsWith("terminal_")) return ["workspace:read"];
  if (id.startsWith("memory") || id.startsWith("agentdb")) return ["workspace:read", "memory:read"];
  return ["workspace:read", "repository:read"];
}

function disabledReason(id: string): string | undefined {
  if (hardDisabled.has(id)) return hardDisabled.get(id);
  if (id.startsWith("browser_") && enabledBrowserTools.has(id)) return undefined;
  for (const [prefix, reason] of hardDisabledPrefixes) if (id.startsWith(prefix)) return reason;
  if (["browser_act", "browser_session_record", "browser_session_end", "browser_session_replay", "browser_template_apply", "browser_cookie_use", "browser_screenshot", "browser_click", "browser_fill", "browser_type", "browser_press", "browser_hover", "browser_select", "browser_check", "browser_uncheck", "browser_scroll", "browser_eval"].includes(id)) {
    return "Browser action is disabled until a dedicated isolated browser driver and SSRF/credential policy are available.";
  }
  return undefined;
}

function schemaFor(id: string): RufloJsonSchema {
  if (id === "terminal_execute") {
    return {
      type: "object",
      properties: {
        command: { type: "string", enum: ["pwd", "ls", "rg", "git", "pnpm"] },
        args: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 16 },
        cwd: { type: "string", maxLength: 500 },
      },
      required: ["command"],
      additionalProperties: false,
    };
  }
  if (id === "browser_open") {
    return {
      type: "object",
      properties: { url: { type: "string", minLength: 1, maxLength: 2_000 }, sessionId: { type: "string", maxLength: 120 } },
      required: ["url"],
      additionalProperties: false,
    };
  }
  return inputSchema;
}

function makeTool(id: string, originalName = id, explicitSourcePath?: string): RufloPhase10ToolSpec {
  const reason = disabledReason(id);
  const browser = id.startsWith("browser_") && !reason;
  const terminal = id === "terminal_execute" || id === "terminal_create" || id === "terminal_list" || id === "terminal_close" || id === "terminal_history";
  const adapter: RufloPhase10ExecutionAdapter = reason
    ? "disabled"
    : browser
      ? "safe_browser"
      : terminal
        ? "sandboxed_terminal"
        : "bounded_evidence";
  const riskLevel: RufloRiskLevel = adapter === "safe_browser" ? "READ_ONLY" : adapter === "sandboxed_terminal" ? "HIGH" : "READ_ONLY";
  const sourcePath = explicitSourcePath ?? sourcePathFor(id);
  return {
    id,
    name: originalName,
    originalName,
    description: reason
      ? `Original Ruflo capability retained as disabled metadata. ${reason}`
      : `Bounded Phase 10 adaptation of original Ruflo tool "${originalName}" using server-owned ${adapter.replaceAll("_", " ")} execution.`,
    source: "ruflo",
    inputSchema: schemaFor(id),
    outputSchema,
    permissions: permissionsFor(id),
    riskLevel,
    timeoutMs: adapter === "safe_browser" ? 15_000 : adapter === "sandboxed_terminal" ? 30_000 : 12_000,
    enabled: !reason,
    approvalRequired: adapter === "safe_browser" || adapter === "sandboxed_terminal",
    provenance: {
      originalRepository: RUFLO_PHASE10_ORIGINAL.repository,
      originalRevision: RUFLO_PHASE10_ORIGINAL.revision,
      sourcePath,
      license: "MIT",
      reuseMode: reason ? "metadata_only" : "adapted",
      originalToolName: originalName,
    },
    agentAccess: { rufloOnly: true, allowedAgentTypes: reason ? [] : [...allowedAgentTypes] },
    resourceLimits: adapter === "sandboxed_terminal" ? { ...resourceLimits, maxConcurrentCalls: 1 } : id.startsWith("memory") ? memoryResourceLimits : resourceLimits,
    availability: reason ? "disabled" : "enabled",
    executionAdapter: adapter,
    implementationKind: reason && (id.startsWith("wasm_") || id.startsWith("transfer_")) ? "metadata-only" : undefined,
  };
}

const originalDefinitions = originalToolNames.map((id) => makeTool(id));
const pluginDefinitions = additionalPluginTools.map((tool) => makeTool(tool.id, tool.originalName, tool.sourcePath));

/**
 * All original declarations are audited here. The registry skips Phase 9's
 * already-registered names so there is still exactly one unified definition
 * and one execution route per identifier.
 */
export const RUFLO_PHASE10_TOOL_DEFINITIONS: RufloPhase10ToolSpec[] = [
  ...originalDefinitions,
  ...pluginDefinitions,
];

export const RUFLO_PHASE10_ORIGINAL_DECLARATION_COUNT = originalDefinitions.length;
export const RUFLO_PHASE10_ADDITIONAL_PLUGIN_DECLARATION_COUNT = pluginDefinitions.length;
export const RUFLO_PHASE10_DISABLED_DECLARATION_COUNT = RUFLO_PHASE10_TOOL_DEFINITIONS.filter((tool) => tool.availability === "disabled").length;
export const RUFLO_PHASE10_ADAPTED_DECLARATION_COUNT = RUFLO_PHASE10_TOOL_DEFINITIONS.filter((tool) => tool.availability === "enabled" && !phase9Names.has(tool.id)).length;
export const RUFLO_PHASE10_PHASE9_DUPLICATE_IDS = [...phase9Names].filter((id) => RUFLO_PHASE10_TOOL_DEFINITIONS.some((tool) => tool.id === id));