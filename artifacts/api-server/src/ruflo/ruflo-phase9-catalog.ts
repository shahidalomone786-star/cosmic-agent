import type { RufloJsonSchema, RufloRiskLevel, RufloToolPermission, RufloUnifiedToolDefinition } from "./ruflo-tool-registry";

/**
 * Phase 9 provenance is intentionally kept as metadata instead of copying the
 * original runtime. The audited Ruflo revision is MIT licensed, but its
 * authority model and infrastructure do not match Cosmic Agent's server
 * boundary. These definitions preserve the reusable catalog concepts while
 * routing execution through existing Cosmic Agent controls.
 */
export const RUFLO_PHASE9_ORIGINAL = {
  repository: "https://github.com/ruvnet/ruflo",
  revision: "db4991967c45c6f72133dff0bb80b0a492960fc1",
  license: "MIT",
  licenseCopyright: "Copyright (c) 2024-2026 ruvnet",
} as const;

export type RufloPhase9ReuseMode = "adapted" | "metadata_only";
export type RufloPhase9Availability = "enabled" | "disabled";

export type RufloToolProvenance = {
  originalRepository: string;
  originalRevision: string;
  sourcePath: string;
  license: "MIT";
  reuseMode: RufloPhase9ReuseMode;
};

export type RufloToolAgentAccess = {
  rufloOnly: true;
  allowedAgentTypes: string[];
};

export type RufloToolResourceLimits = {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxResults: number;
  maxConcurrentCalls: number;
};

export type RufloPhase9ToolSpec = Omit<RufloUnifiedToolDefinition, "source"> & {
  source: "ruflo";
  provenance: RufloToolProvenance;
  agentAccess: RufloToolAgentAccess;
  resourceLimits: RufloToolResourceLimits;
  availability: RufloPhase9Availability;
};

export type RufloPhase9AgentDefinition = {
  id: string;
  name: string;
  description: string;
  model: "haiku" | "sonnet" | "opus";
  prompt: string;
  sourcePath: string;
  pluginName: string;
  capabilities: string[];
  rufloOnly: true;
};

export type RufloPhase9PluginCapability = {
  id: string;
  pluginName: string;
  description: string;
  sourcePath: string;
  capability: string;
  adaptedTo: string;
  status: "adapted" | "metadata_only";
  rufloOnly: true;
};

const boundedString = (maxLength: number): RufloJsonSchema => ({ type: "string", minLength: 1, maxLength });
const optionalString = (maxLength: number): RufloJsonSchema => ({ type: "string", maxLength });
const objectSchema = (properties: Record<string, RufloJsonSchema>, required: string[] = []): RufloJsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const provenance = (sourcePath: string, reuseMode: RufloPhase9ReuseMode): RufloToolProvenance => ({
  originalRepository: RUFLO_PHASE9_ORIGINAL.repository,
  originalRevision: RUFLO_PHASE9_ORIGINAL.revision,
  license: RUFLO_PHASE9_ORIGINAL.license,
  sourcePath,
  reuseMode,
});

const safeAccess = (allowedAgentTypes: string[]): RufloToolAgentAccess => ({
  rufloOnly: true,
  allowedAgentTypes,
});

const readLimits: RufloToolResourceLimits = {
  maxInputBytes: 4_000,
  maxOutputBytes: 32_000,
  maxResults: 48,
  maxConcurrentCalls: 2,
};

const memoryLimits: RufloToolResourceLimits = {
  maxInputBytes: 8_000,
  maxOutputBytes: 24_000,
  maxResults: 24,
  maxConcurrentCalls: 1,
};

const adaptedTool = (input: {
  id: string;
  description: string;
  sourcePath: string;
  inputSchema: RufloJsonSchema;
  permissions: RufloToolPermission[];
  riskLevel?: RufloRiskLevel;
  approvalRequired?: boolean;
  resourceLimits?: RufloToolResourceLimits;
}): RufloPhase9ToolSpec => ({
  id: input.id,
  name: input.id,
  description: input.description,
  source: "ruflo",
  inputSchema: input.inputSchema,
  outputSchema: { type: "object", additionalProperties: true },
  permissions: input.permissions,
  riskLevel: input.riskLevel ?? "READ_ONLY",
  timeoutMs: 12_000,
  enabled: true,
  approvalRequired: input.approvalRequired ?? false,
  provenance: provenance(input.sourcePath, "adapted"),
  agentAccess: safeAccess([
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
  ]),
  resourceLimits: input.resourceLimits ?? readLimits,
  availability: "enabled",
});

export const RUFLO_PHASE9_IMPORTED_TOOLS: RufloPhase9ToolSpec[] = [
  adaptedTool({
    id: "memory_search",
    description: "Search the bounded project memory store using keyword and optional embedding relevance.",
    sourcePath: "v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts",
    inputSchema: objectSchema({ query: boundedString(500), projectKey: optionalString(300), limit: { type: "integer", maxItems: 24 } }, ["query"]),
    permissions: ["workspace:read", "memory:read"],
    resourceLimits: memoryLimits,
  }),
  adaptedTool({
    id: "memory_store",
    description: "Store one sanitized, project-scoped memory fact for future Ruflo runs.",
    sourcePath: "v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts",
    inputSchema: objectSchema({
      fact: boundedString(1_000),
      kind: boundedString(80),
      projectKey: optionalString(300),
      confidence: { type: "number" },
      importance: { type: "integer" },
    }, ["fact", "kind"]),
    permissions: ["workspace:read", "memory:write"],
    riskLevel: "LOW",
    approvalRequired: true,
    resourceLimits: memoryLimits,
  }),
  adaptedTool({
    id: "memory_cleanup",
    description: "Remove obsolete project-scoped memory facts using the existing memory retention policy.",
    sourcePath: "v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts",
    inputSchema: objectSchema({ projectKey: optionalString(300), maxDeletes: { type: "integer", maxItems: 24 } }),
    permissions: ["workspace:read", "memory:write"],
    riskLevel: "MEDIUM",
    approvalRequired: true,
    resourceLimits: memoryLimits,
  }),
  adaptedTool({
    id: "memory_stats",
    description: "Return bounded project memory counts and configured embedding status.",
    sourcePath: "v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts",
    inputSchema: objectSchema({ projectKey: optionalString(300) }),
    permissions: ["workspace:read", "memory:read"],
    resourceLimits: memoryLimits,
  }),
  adaptedTool({
    id: "agentdb_health",
    description: "Report the health of Cosmic Agent's compatible persistent memory substrate.",
    sourcePath: "plugins/ruflo-agentdb/README.md",
    inputSchema: objectSchema({ projectKey: optionalString(300) }),
    permissions: ["workspace:read", "memory:read"],
    resourceLimits: memoryLimits,
  }),
  adaptedTool({
    id: "guidance_capabilities",
    description: "List the currently registered Ruflo tools, imported agents, and plugin capabilities.",
    sourcePath: "v3/@claude-flow/cli/src/mcp-tools/guidance-tools.ts",
    inputSchema: objectSchema({ includeDisabled: { type: "boolean" } }),
    permissions: ["workspace:read"],
    resourceLimits: readLimits,
  }),
  adaptedTool({
    id: "system_info",
    description: "Return bounded Ruflo runtime and catalog provenance information.",
    sourcePath: "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
    inputSchema: objectSchema({}),
    permissions: ["workspace:read"],
    resourceLimits: readLimits,
  }),
  adaptedTool({
    id: "system_health",
    description: "Return a bounded health summary for the Ruflo runtime surfaces.",
    sourcePath: "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
    inputSchema: objectSchema({}),
    permissions: ["workspace:read"],
    resourceLimits: readLimits,
  }),
];

const disabledOriginalTool = (id: string, description: string, sourcePath: string, permissions: RufloToolPermission[] = ["workspace:read"]): RufloPhase9ToolSpec => ({
  id,
  name: id,
  description,
  source: "ruflo",
  inputSchema: objectSchema({}),
  outputSchema: { type: "object", additionalProperties: true },
  permissions,
  riskLevel: "HIGH",
  timeoutMs: 12_000,
  enabled: false,
  approvalRequired: true,
  provenance: provenance(sourcePath, "metadata_only"),
  agentAccess: safeAccess([]),
  resourceLimits: readLimits,
  availability: "disabled",
});

export const RUFLO_PHASE9_EXCLUDED_TOOL_DEFINITIONS: RufloPhase9ToolSpec[] = [
  disabledOriginalTool("agent_spawn", "Original agent spawning requires a separate process/runtime authority; use the existing Phase 8 authenticated swarm registration path.", "v3/@claude-flow/cli/src/mcp-tools/agent-tools.ts", ["workspace:read"]),
  disabledOriginalTool("agent_execute", "Original agent execution depends on an external Anthropic-managed runtime and is not enabled in Cosmic Agent.", "v3/@claude-flow/cli/src/mcp-tools/agent-tools.ts", ["workspace:read"]),
  disabledOriginalTool("terminal_execute", "Unrestricted terminal execution is not compatible with the current Ruflo workspace security boundary.", "v3/@claude-flow/cli/src/mcp-tools/terminal-tools.ts", ["workspace:read"]),
  disabledOriginalTool("browser_open", "Browser navigation requires a dedicated SSRF-safe browser service that is not present in this artifact.", "v3/@claude-flow/cli/src/mcp-tools/browser-tools.ts", ["network:outbound"]),
  disabledOriginalTool("workflow_execute", "Original workflow execution is not imported because Phase 8's bounded DAG/workflow runtime is the single orchestration authority.", "v3/@claude-flow/cli/src/mcp-tools/workflow-tools.ts", ["workspace:read"]),
  disabledOriginalTool("federation_bbs_publish", "Cross-machine federation would duplicate neither the current local swarm nor its trust boundary, so it remains excluded.", "v3/@claude-flow/cli/src/mcp-tools/agentbbs-tools.ts", ["network:outbound"]),
  disabledOriginalTool("policy_approve", "Policy approval must remain server-held and cannot be delegated to a native tool.", "v3/@claude-flow/cli/src/mcp-tools/policy-tools.ts", ["workspace:read"]),
];

const agent = (input: Omit<RufloPhase9AgentDefinition, "rufloOnly">): RufloPhase9AgentDefinition => ({
  ...input,
  rufloOnly: true,
});

export const RUFLO_PHASE9_IMPORTED_AGENTS: RufloPhase9AgentDefinition[] = [
  agent({ id: "researcher", name: "Researcher", description: "Bounded evidence gathering and repository research.", model: "sonnet", prompt: "Research only from server-provided repository, workspace, and memory evidence. Do not infer unavailable facts.", pluginName: "ruflo-core", sourcePath: "plugins/ruflo-core/agents/researcher.md", capabilities: ["context:read", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "coder", name: "Coder", description: "Implementation planning and proposal preparation without direct writes.", model: "sonnet", prompt: "Prepare bounded change proposals from current evidence. Never apply, commit, or push.", pluginName: "ruflo-core", sourcePath: "plugins/ruflo-core/agents/coder.md", capabilities: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "reviewer", name: "Reviewer", description: "Read-only change and proposal review.", model: "sonnet", prompt: "Review evidence and proposals; report risks and findings without modifying the repository.", pluginName: "ruflo-core", sourcePath: "plugins/ruflo-core/agents/reviewer.md", capabilities: ["context:read", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "tester", name: "Tester", description: "Test design and coverage-gap analysis.", model: "sonnet", prompt: "Identify focused test coverage gaps from bounded source evidence. Test execution remains validator-owned.", pluginName: "ruflo-testgen", sourcePath: "plugins/ruflo-testgen/agents/tester.md", capabilities: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "docs-writer", name: "Documentation Writer", description: "Documentation drift and proposal analysis.", model: "haiku", prompt: "Identify documentation drift and propose documentation changes from current source evidence.", pluginName: "ruflo-docs", sourcePath: "plugins/ruflo-docs/agents/docs-writer.md", capabilities: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "git-specialist", name: "Git Specialist", description: "Read-only Git and change-risk intelligence.", model: "sonnet", prompt: "Analyze repository state and change risk without committing, pushing, or changing Git state.", pluginName: "ruflo-jujutsu", sourcePath: "plugins/ruflo-jujutsu/agents/git-specialist.md", capabilities: ["context:read", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "security-auditor", name: "Security Auditor", description: "Security boundary and dependency-risk analysis.", model: "sonnet", prompt: "Look for security risks in supplied evidence. Do not weaken controls or execute untrusted commands.", pluginName: "ruflo-security-audit", sourcePath: "plugins/ruflo-security-audit/agents/security-auditor.md", capabilities: ["context:read", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "memory-specialist", name: "Memory Specialist", description: "Project memory and retrieval analysis.", model: "sonnet", prompt: "Use only project-scoped memory APIs and treat current repository evidence as authoritative.", pluginName: "ruflo-rag-memory", sourcePath: "plugins/ruflo-rag-memory/agents/memory-specialist.md", capabilities: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "goal-planner", name: "Goal Planner", description: "Bounded goal decomposition.", model: "sonnet", prompt: "Decompose goals into bounded read-first steps; do not create recurring or autonomous work.", pluginName: "ruflo-goals", sourcePath: "plugins/ruflo-goals/agents/goal-planner.md", capabilities: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "workflow-specialist", name: "Workflow Specialist", description: "Bounded workflow and dependency planning.", model: "sonnet", prompt: "Use the existing DAG scheduler and durable swarm state; do not create a second workflow runtime.", pluginName: "ruflo-workflows", sourcePath: "plugins/ruflo-workflows/agents/workflow-specialist.md", capabilities: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "intelligence-specialist", name: "Intelligence Specialist", description: "Repository and memory intelligence routing.", model: "sonnet", prompt: "Rank available evidence and compatible capabilities without inventing repository facts.", pluginName: "ruflo-intelligence", sourcePath: "plugins/ruflo-intelligence/agents/intelligence-specialist.md", capabilities: ["context:read", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "browser-agent", name: "Browser Agent", description: "Bounded browser-oriented analysis metadata.", model: "sonnet", prompt: "Browser capability is limited to explicitly provided safe checks; never navigate arbitrary origins.", pluginName: "ruflo-browser", sourcePath: "plugins/ruflo-browser/agents/browser-agent.md", capabilities: ["context:read", "message:send", "message:receive", "consensus:vote"] }),
  agent({ id: "sparc-orchestrator", name: "SPARC Orchestrator", description: "Specification-to-completion phase planning.", model: "sonnet", prompt: "Represent SPARC as bounded planning metadata while preserving proposal, approval, and validation ownership.", pluginName: "ruflo-sparc", sourcePath: "plugins/ruflo-sparc/agents/sparc-orchestrator.md", capabilities: ["context:read", "context:write", "message:send", "message:receive", "consensus:vote"] }),
];

export const RUFLO_PHASE9_PLUGIN_CAPABILITIES: RufloPhase9PluginCapability[] = [
  { id: "ruflo-core", pluginName: "ruflo-core", description: "Core agent/tool concepts and safe catalog metadata.", sourcePath: "plugins/ruflo-core/.claude-plugin/plugin.json", capability: "core-catalog", adaptedTo: "Phase 9 catalog and unified tool registry", status: "adapted", rufloOnly: true },
  { id: "ruflo-agentdb", pluginName: "ruflo-agentdb", description: "AgentDB memory substrate concepts.", sourcePath: "plugins/ruflo-agentdb/.claude-plugin/plugin.json", capability: "persistent-memory", adaptedTo: "existing PostgreSQL Ruflo memory store", status: "adapted", rufloOnly: true },
  { id: "ruflo-rag-memory", pluginName: "ruflo-rag-memory", description: "Project-scoped recall and memory bridge concepts.", sourcePath: "plugins/ruflo-rag-memory/.claude-plugin/plugin.json", capability: "rag-memory", adaptedTo: "existing keyword/cosine memory retrieval", status: "adapted", rufloOnly: true },
  { id: "ruflo-intelligence", pluginName: "ruflo-intelligence", description: "Evidence ranking and intelligence routing.", sourcePath: "plugins/ruflo-intelligence/.claude-plugin/plugin.json", capability: "intelligence-routing", adaptedTo: "Ruflo planner and provider router", status: "adapted", rufloOnly: true },
  { id: "ruflo-testgen", pluginName: "ruflo-testgen", description: "Test gap and TDD workflow concepts.", sourcePath: "plugins/ruflo-testgen/.claude-plugin/plugin.json", capability: "test-generation", adaptedTo: "existing specialized test generator", status: "adapted", rufloOnly: true },
  { id: "ruflo-docs", pluginName: "ruflo-docs", description: "Documentation drift and generation concepts.", sourcePath: "plugins/ruflo-docs/.claude-plugin/plugin.json", capability: "documentation", adaptedTo: "existing documentation specialized agent", status: "adapted", rufloOnly: true },
  { id: "ruflo-jujutsu", pluginName: "ruflo-jujutsu", description: "Read-only Git intelligence concepts.", sourcePath: "plugins/ruflo-jujutsu/.claude-plugin/plugin.json", capability: "git-intelligence", adaptedTo: "existing Git intelligence specialized agent", status: "adapted", rufloOnly: true },
  { id: "ruflo-security-audit", pluginName: "ruflo-security-audit", description: "Security review and policy gate concepts.", sourcePath: "plugins/ruflo-security-audit/.claude-plugin/plugin.json", capability: "security-audit", adaptedTo: "existing auth, approval, workspace, Git, and audit controls", status: "adapted", rufloOnly: true },
  { id: "ruflo-observability", pluginName: "ruflo-observability", description: "Structured tracing and metrics concepts.", sourcePath: "plugins/ruflo-observability/.claude-plugin/plugin.json", capability: "observability", adaptedTo: "existing live events, jobs, provider metrics, and audit log", status: "adapted", rufloOnly: true },
  { id: "ruflo-swarm", pluginName: "ruflo-swarm", description: "Swarm topology, mailbox, blackboard, lease, and consensus concepts.", sourcePath: "plugins/ruflo-swarm/.claude-plugin/plugin.json", capability: "swarm-coordination", adaptedTo: "existing Phase 8 authenticated swarm service", status: "adapted", rufloOnly: true },
  { id: "ruflo-workflows", pluginName: "ruflo-workflows", description: "Workflow lifecycle and dependency orchestration concepts.", sourcePath: "plugins/ruflo-workflows/.claude-plugin/plugin.json", capability: "workflow-orchestration", adaptedTo: "existing bounded DAG scheduler and workflow runtime", status: "adapted", rufloOnly: true },
  { id: "ruflo-goals", pluginName: "ruflo-goals", description: "Goal decomposition concepts.", sourcePath: "plugins/ruflo-goals/.claude-plugin/plugin.json", capability: "goal-planning", adaptedTo: "existing bounded Ruflo planner", status: "adapted", rufloOnly: true },
  { id: "ruflo-browser", pluginName: "ruflo-browser", description: "Browser analysis concepts.", sourcePath: "plugins/ruflo-browser/.claude-plugin/plugin.json", capability: "browser-analysis", adaptedTo: "existing bounded browser specialized agent", status: "adapted", rufloOnly: true },
  { id: "ruflo-sparc", pluginName: "ruflo-sparc", description: "SPARC phase-gate methodology.", sourcePath: "plugins/ruflo-sparc/.claude-plugin/plugin.json", capability: "phase-gates", adaptedTo: "existing proposal/approval/validation workflow", status: "adapted", rufloOnly: true },
  { id: "ruflo-agent", pluginName: "ruflo-agent", description: "WASM and managed-agent runtime concepts.", sourcePath: "plugins/ruflo-agent/.claude-plugin/plugin.json", capability: "agent-runtimes", adaptedTo: "metadata only; no external or local autonomous runtime", status: "metadata_only", rufloOnly: true },
];

export const RUFLO_PHASE9_AGENT_CAPABILITIES: Record<string, string[]> = Object.fromEntries(
  RUFLO_PHASE9_IMPORTED_AGENTS.map((definition) => [definition.id, [...definition.capabilities]]),
);

export const RUFLO_PHASE9_IMPORTED_TOOL_COUNT = RUFLO_PHASE9_IMPORTED_TOOLS.length;
export const RUFLO_PHASE9_EXCLUDED_TOOL_COUNT = RUFLO_PHASE9_EXCLUDED_TOOL_DEFINITIONS.length;
export const RUFLO_PHASE9_IMPORTED_AGENT_COUNT = RUFLO_PHASE9_IMPORTED_AGENTS.length;
export const RUFLO_PHASE9_PLUGIN_CAPABILITY_COUNT = RUFLO_PHASE9_PLUGIN_CAPABILITIES.length;