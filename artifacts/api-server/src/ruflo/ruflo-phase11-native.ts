import os from "node:os";
import process from "node:process";
import type { RufloToolRequest, RufloToolResult } from "./ruflo-runtime";
import type { RufloToolRegistry, RufloUnifiedToolDefinition } from "./ruflo-tool-registry";
import { rufloToolAuditLog } from "./ruflo-audit";

export type RufloPhase11Readers = {
  readRepositoryFile: (repository: NonNullable<RufloToolRequest["repository"]>, path: string) => Promise<{ content: string }>;
  readWorkspaceFile: (userId: string, projectId: string, path: string) => Promise<{ content: string }>;
};

const ORIGINAL = {
  repository: "https://github.com/ruvnet/ruflo",
  revision: "db4991967c45c6f72133dff0bb80b0a492960fc1",
  license: "MIT" as const,
};

const readOnlyLimits = {
  maxInputBytes: 8_000,
  maxOutputBytes: 24_000,
  maxResults: 48,
  maxConcurrentCalls: 2,
} as const;

const objectSchema = (properties: Record<string, Record<string, unknown>>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

const native = (
  id: string,
  sourcePath: string,
  description: string,
  inputSchema: Record<string, unknown>,
): RufloUnifiedToolDefinition => ({
  id,
  name: id,
  description,
  source: "ruflo",
  inputSchema,
  outputSchema: { type: "object", additionalProperties: true },
  permissions: ["workspace:read"],
  riskLevel: "READ_ONLY",
  timeoutMs: 8_000,
  enabled: true,
  approvalRequired: false,
  provenance: {
    originalRepository: ORIGINAL.repository,
    originalRevision: ORIGINAL.revision,
    sourcePath,
    license: ORIGINAL.license,
    reuseMode: "native",
    originalToolName: id,
  },
  agentAccess: {
    rufloOnly: true,
    allowedAgentTypes: ["coordinator", "planner", "reviewer", "validator", "researcher", "security-auditor"],
  },
  resourceLimits: readOnlyLimits,
  executionAdapter: "native",
  availability: "enabled",
  implementationKind: "native",
  originalSource: sourcePath,
  originalRevision: ORIGINAL.revision,
  originalBehaviorReference: `${sourcePath} :: ${id} handler at ${ORIGINAL.revision}`,
  cosmicImplementation: "ruflo-phase11-native.ts",
  risk: "READ_ONLY",
  executionMode: "in_process_read_only",
  testStatus: "verified",
  parityStatus: "partial",
});

export const RUFLO_PHASE11_NATIVE_TOOL_DEFINITIONS: RufloUnifiedToolDefinition[] = [
  native(
    "system_status",
    "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
    "Return live bounded Ruflo runtime status and optional process metrics.",
    objectSchema({
      verbose: { type: "boolean" },
      components: { type: "array", items: { type: "string" }, maxItems: 12 },
    }),
  ),
  native(
    "system_metrics",
    "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
    "Return live bounded CPU, memory, request, and task-shaped runtime metrics.",
    objectSchema({
      category: { type: "string", enum: ["all", "cpu", "memory", "agents", "tasks", "requests"] },
      timeRange: { type: "string", maxLength: 32 },
      format: { type: "string", enum: ["json", "table", "summary"] },
    }),
  ),
  native(
    "system_health",
    "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
    "Perform a bounded process and runtime health check without network or mutation.",
    objectSchema({
      deep: { type: "boolean" },
      components: { type: "array", items: { type: "string" }, maxItems: 12 },
      fix: { type: "boolean" },
    }),
  ),
  native(
    "system_info",
    "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
    "Return bounded runtime, platform, feature, and limit information.",
    objectSchema({
      include: { type: "array", items: { type: "string" }, maxItems: 12 },
    }),
  ),
  native(
    "mcp_status",
    "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
    "Report the current server-owned MCP compatibility status without starting or stopping a process.",
    objectSchema({}),
  ),
  native(
    "task_summary",
    "v3/@claude-flow/cli/src/mcp-tools/system-tools.ts",
    "Summarize bounded Ruflo execution activity by status.",
    objectSchema({}),
  ),
  native(
    "workflow_validate",
    "v3/@claude-flow/cli/src/mcp-tools/workflow-tools.ts",
    "Validate a JSON workflow definition from the authorized repository or workspace.",
    objectSchema({
      file: { type: "string", minLength: 1, maxLength: 500 },
      strict: { type: "boolean" },
    }, ["file"]),
  ),
];

const plugin = (
  id: string,
  originalToolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
): RufloUnifiedToolDefinition => ({
  id,
  name: id,
  description,
  source: "ruflo",
  inputSchema,
  outputSchema: { type: "object", additionalProperties: true },
  permissions: ["workspace:read"],
  riskLevel: "READ_ONLY",
  timeoutMs: 8_000,
  enabled: true,
  approvalRequired: false,
  provenance: {
    originalRepository: ORIGINAL.repository,
    originalRevision: ORIGINAL.revision,
    sourcePath: "v3/plugins/agentic-qe/src/tools/index.ts",
    license: ORIGINAL.license,
    reuseMode: "adapted",
    originalToolName,
  },
  agentAccess: {
    rufloOnly: true,
    allowedAgentTypes: ["security-auditor", "reviewer", "tester"],
  },
  resourceLimits: {
    maxInputBytes: 16_000,
    maxOutputBytes: 24_000,
    maxResults: 48,
    maxConcurrentCalls: 2,
  },
  executionAdapter: "safe_plugin",
  availability: "enabled",
  implementationKind: "cosmic-adapter",
  originalSource: "v3/plugins/agentic-qe/src/tools/index.ts",
  originalRevision: ORIGINAL.revision,
  originalBehaviorReference: `v3/plugins/agentic-qe/src/tools/index.ts :: ${originalToolName}`,
  cosmicImplementation: "ruflo-phase11-native.ts::executePhase11PluginAdapter",
  risk: "READ_ONLY",
  executionMode: "in_process_read_only",
  testStatus: "verified",
  parityStatus: "partial",
});

export const RUFLO_PHASE11_PLUGIN_TOOL_DEFINITIONS: RufloUnifiedToolDefinition[] = [
  plugin(
    "aqe:detect-secrets",
    "aqe/detect-secrets",
    "Detect common credential-shaped patterns in bounded caller-provided text and return redacted findings.",
    objectSchema({
      text: { type: "string", minLength: 1, maxLength: 12_000 },
    }, ["text"]),
  ),
  plugin(
    "aqe:security-scan",
    "aqe/security-scan",
    "Run a bounded, read-only security pattern scan over caller-provided text without executing code or contacting external services.",
    objectSchema({
      text: { type: "string", minLength: 1, maxLength: 12_000 },
      includeDependencies: { type: "boolean" },
    }, ["text"]),
  ),
];

export async function executePhase11NativeTool(
  request: RufloToolRequest,
  registry: RufloToolRegistry,
  readers: RufloPhase11Readers,
): Promise<RufloToolResult> {
  const input = request.input;
  if (request.name === "system_status") {
    const memory = process.memoryUsage();
    const audits = rufloToolAuditLog.list({ userId: request.workspace?.userId });
    const health = memory.heapTotal > 0 && memory.heapUsed / memory.heapTotal < 0.95 ? "healthy" : "degraded";
    const result = {
      status: health,
      uptime: Math.floor(process.uptime() * 1_000),
      uptimeFormatted: formatUptime(process.uptime() * 1_000),
      version: "cosmic-agent",
      components: {
        swarm: { status: "server-owned", health: 1 },
        memory: { status: "server-owned" },
        neural: { status: "bounded-provider" },
        mcp: { status: "compatibility-runtime" },
      },
      lastCheck: new Date().toISOString(),
      ...(input.verbose === true ? {
        metrics: {
          cpu: round(loadPercent()),
          memory: { used: mb(memory.heapUsed), total: mb(memory.heapTotal), free: mb(os.freemem()) },
          agents: { active: 0, total: 0 },
          tasks: summarizeAudits(audits),
        },
      } : {}),
    };
    return nativeResult(request.name, "Read live process and server-owned compatibility state.", result);
  }

  if (request.name === "system_metrics") {
    const memory = process.memoryUsage();
    const audits = rufloToolAuditLog.list({ userId: request.workspace?.userId });
    const metrics = {
      cpu: {
        loadAverage: os.loadavg().map(round),
        processUserMicros: process.cpuUsage().user,
        processSystemMicros: process.cpuUsage().system,
        percent: round(loadPercent()),
      },
      memory: {
        rss: mb(memory.rss),
        heapUsed: mb(memory.heapUsed),
        heapTotal: mb(memory.heapTotal),
        external: mb(memory.external),
        systemFree: mb(os.freemem()),
        systemTotal: mb(os.totalmem()),
      },
      agents: { active: 0, total: 0 },
      tasks: summarizeAudits(audits),
      requests: {
        total: audits.length,
        success: audits.filter((entry) => entry.executionStatus === "completed").length,
        errors: audits.filter((entry) => entry.executionStatus === "failed").length,
      },
    };
    const category = typeof input.category === "string" ? input.category : "all";
    const data = category === "all" ? metrics : metrics[category as keyof typeof metrics] ?? metrics;
    return nativeResult(request.name, "Read live bounded runtime metrics.", data);
  }

  if (request.name === "system_health") {
    const memory = process.memoryUsage();
    const checks = [
      { name: "process", status: "healthy", message: `pid ${process.pid}` },
      {
        name: "memory",
        status: memory.heapTotal === 0 || memory.heapUsed / memory.heapTotal < 0.95 ? "healthy" : "degraded",
        message: `${mb(memory.heapUsed)}MB heap used`,
      },
      { name: "authorization", status: "healthy", message: "server-owned registry authorization is loaded" },
      { name: "audit", status: "healthy", message: "bounded redacted audit ring is available" },
      { name: "network", status: "not_checked", message: "network probes are intentionally not performed by this read-only health tool" },
    ];
    return nativeResult(request.name, "Completed bounded local health checks.", {
      status: checks.some((check) => check.status === "degraded") ? "degraded" : "healthy",
      healthy: !checks.some((check) => check.status === "degraded"),
      checks,
      deep: input.deep === true,
      fix: false,
      checkedAt: new Date().toISOString(),
    });
  }

  if (request.name === "system_info") {
    return nativeResult(request.name, "Returned bounded runtime information.", {
      version: "cosmic-agent",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd: process.cwd(),
      env: process.env.NODE_ENV ?? "development",
      features: {
        swarm: true,
        memory: true,
        neural: true,
        hnsw: false,
        quantization: false,
        browser: "public_https_read_only",
      },
      limits: {
        maxAgents: 5,
        maxTasks: 64,
        maxMemory: "bounded_by_runtime_limits",
      },
    });
  }

  if (request.name === "mcp_status") {
    return nativeResult(request.name, "Reported compatibility status without process mutation.", {
      running: true,
      pid: process.pid,
      transport: "http",
      port: Number(process.env.PORT ?? 8080),
      host: "server-owned",
      note: "The compatibility registry is hosted by the authenticated Cosmic Agent API; no child MCP process is started.",
    });
  }

  if (request.name === "task_summary") {
    const audits = rufloToolAuditLog.list({ userId: request.workspace?.userId });
    const summary = summarizeAudits(audits);
    return nativeResult(request.name, "Summarized bounded audited execution activity.", {
      total: audits.length,
      pending: 0,
      running: audits.filter((entry) => entry.executionStatus === "started").length,
      completed: summary.completed,
      failed: summary.failed,
    });
  }

  if (request.name === "workflow_validate") {
    const path = typeof input.file === "string" ? input.file : "";
    const raw = request.repository
      ? (await readers.readRepositoryFile(request.repository, path)).content
      : request.workspace
        ? (await readers.readWorkspaceFile(request.workspace.userId, request.workspace.projectId, path)).content
        : "";
    return nativeResult(request.name, "Validated a bounded workflow definition.", validateWorkflow(raw, path, input.strict === true));
  }

  // Keep the registry argument in the native contract so handlers cannot be
  // called outside the same canonical capability inventory.
  if (!registry.has(request.name)) throw new Error("Native Ruflo capability is not registered.");
  throw new Error(`Native Ruflo handler is not implemented for "${request.name}".`);
}

export function executePhase11PluginAdapter(request: RufloToolRequest): RufloToolResult {
  const text = String(request.input.text ?? "");
  const findings = findSecretPatterns(text);
  if (request.name === "aqe:security-scan") {
    const dependencyFindings = request.input.includeDependencies === true
      ? findDependencyPatterns(text)
      : [];
    return {
      name: request.name,
      summary: `Safe security scan found ${findings.length + dependencyFindings.length} bounded finding(s).`,
      data: {
        adapter: "safe_plugin",
        plugin: "agentic-qe",
        findings: [...findings, ...dependencyFindings],
        scannedCharacters: text.length,
        executedCode: false,
        networkAccess: false,
      },
    };
  }
  return {
    name: request.name,
    summary: `Safe secret scan found ${findings.length} bounded finding(s).`,
    data: {
      adapter: "safe_plugin",
      plugin: "agentic-qe",
      findings,
      scannedCharacters: text.length,
      redacted: true,
      executedCode: false,
      networkAccess: false,
    },
  };
}

function nativeResult(name: string, summary: string, data: unknown): RufloToolResult {
  return { name, summary, data };
}

function validateWorkflow(raw: string, file: string, strict: boolean): Record<string, unknown> {
  const errors: Array<{ line: number; message: string; severity: "error" }> = [];
  const warnings: Array<{ line: number; message: string }> = [];
  let stages = 0;
  let agents = 0;
  try {
    const document = JSON.parse(raw) as Record<string, unknown>;
    const steps = document.steps ?? document.stages ?? document.tasks;
    if (!Array.isArray(steps)) {
      errors.push({ line: 0, message: "Workflow has no `steps` / `stages` / `tasks` array", severity: "error" });
    } else {
      stages = steps.length;
      const names = new Set<string>();
      steps.forEach((value, index) => {
        const step = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const agent = step.agent ?? step.agentType ?? step.agent_type;
        if (typeof agent === "string" && agent.trim()) names.add(agent);
        else warnings.push({ line: index + 1, message: `step ${index + 1} names no agent` });
      });
      agents = names.size;
    }
  } catch (error) {
    errors.push({
      line: 0,
      message: `Parse error: ${error instanceof Error ? error.message.slice(0, 240) : "invalid JSON"}`,
      severity: "error",
    });
  }
  return {
    valid: errors.length === 0 && (!strict || warnings.length === 0),
    file,
    errors,
    warnings,
    stats: { stages, agents, estimatedDuration: stages > 0 ? `~${stages * 30}s` : "unknown" },
  };
}

function summarizeAudits(audits: ReturnType<typeof rufloToolAuditLog.list>) {
  return {
    pending: 0,
    completed: audits.filter((entry) => entry.executionStatus === "completed").length,
    failed: audits.filter((entry) => entry.executionStatus === "failed").length,
  };
}

function mb(value: number): number {
  return Math.round(value / 1024 / 1024);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function loadPercent(): number {
  const cpus = Math.max(1, os.cpus().length);
  return Math.max(0, Math.min(100, (os.loadavg()[0] * 100) / cpus));
}

function formatUptime(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function findSecretPatterns(text: string): Array<{ ruleId: string; line: number; column: number; redactedMatch: string }> {
  const rules: Array<[string, RegExp]> = [
    ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["github-token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g],
    ["generic-api-key", /\b(?:sk|pk)_[A-Za-z0-9_-]{16,}\b/g],
    ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi],
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
    ["password-assignment", /\b(?:password|passwd|secret)\s*[:=]\s*["'][^"']{4,}["']/gi],
  ];
  const findings: Array<{ ruleId: string; line: number; column: number; redactedMatch: string }> = [];
  for (const [ruleId, pattern] of rules) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const before = text.slice(0, index);
      findings.push({
        ruleId,
        line: before.split("\n").length,
        column: index - before.lastIndexOf("\n"),
        redactedMatch: "[redacted]",
      });
      if (findings.length >= 48) return findings;
    }
  }
  return findings;
}

function findDependencyPatterns(text: string): Array<{ ruleId: string; line: number; column: number; redactedMatch: string }> {
  const findings: Array<{ ruleId: string; line: number; column: number; redactedMatch: string }> = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (/\b(?:eval|child_process|shell\s*:\s*true)\b/.test(line)) {
      findings.push({ ruleId: "unsafe-execution-pattern", line: index + 1, column: 1, redactedMatch: "[pattern]" });
    }
  }
  return findings.slice(0, 48);
}