import { createHash, randomUUID } from "node:crypto";
import {
  McpTool,
  RufloMcpClient,
  RufloMcpClientError,
  RufloMcpTransportConfiguration,
  redactMcpValue,
} from "./ruflo-mcp-client";
import {
  mcpToolId,
  RufloJsonSchema,
  RufloRiskLevel,
  RufloToolPermission,
  RufloToolRegistry,
  RufloToolRegistryError,
  RufloUnifiedToolDefinition,
  validateJsonSchema,
} from "./ruflo-tool-registry";
import { RufloToolAuditLog, rufloToolAuditLog } from "./ruflo-audit";
import { safeWorkspaceRelative } from "../workspace/local-workspace";

export type RufloMcpScope =
  | { type: "user" }
  | { type: "project"; projectId: string };

export type RufloMcpToolPolicy = {
  riskLevel: RufloRiskLevel;
  permissions: RufloToolPermission[];
  approvalRequired?: boolean;
  outputSchema?: RufloJsonSchema;
};

export type RufloMcpServerConfiguration = {
  serverName: string;
  ownerId: string;
  scope: RufloMcpScope;
  transport: RufloMcpTransportConfiguration;
  enabled: boolean;
  allowedTools: string[];
  toolPolicies: Record<string, RufloMcpToolPolicy>;
  permissions: RufloToolPermission[];
  timeoutMs: number;
  autoApproveLowRisk: boolean;
};

export type RufloMcpExecutionContext = {
  userId: string;
  sessionId: string;
  projectId?: string;
  toolId: string;
  taskId?: string;
  input: unknown;
  approvalId?: string;
};

export type RufloToolExecutionResult =
  | {
      ok: true;
      toolId: string;
      serverName: string;
      toolName: string;
      output: unknown;
      approvalStatus: "not_required" | "approved";
    }
  | {
      ok: false;
      toolId: string;
      error: { category: string; message: string };
      approvalStatus: "required" | "rejected" | "not_required";
    };

type ToolApproval = {
  approvalId: string;
  userId: string;
  sessionId: string;
  taskId?: string;
  toolId: string;
  inputHash: string;
  approvedAt: string;
};

type SessionUsage = { calls: number; active: number };

export type RufloMcpManagerOptions = {
  registry?: RufloToolRegistry;
  auditLog?: RufloToolAuditLog;
  allowedServerNames?: string[];
  allowedCommands?: string[];
  allowedHosts?: string[];
  maxToolCalls?: number;
  maxConcurrentCalls?: number;
  isSessionOwned?: (userId: string, sessionId: string) => boolean;
  clientFactory?: (configuration: RufloMcpTransportConfiguration) => RufloMcpClientLike;
};

export type RufloMcpClientLike = Pick<RufloMcpClient, "connect" | "listTools" | "callTool" | "close">;

export class RufloMcpManagerError extends Error {
  constructor(
    readonly code:
      | "invalid_configuration"
      | "server_not_allowed"
      | "server_not_found"
      | "server_disabled"
      | "tool_not_allowed"
      | "tool_not_found"
      | "session_unauthorized"
      | "approval_required"
      | "invalid_approval"
      | "limit"
      | "schema_invalid"
      | "discovery_failed"
      | "execution_failed",
    message: string,
  ) {
    super(message);
    this.name = "RufloMcpManagerError";
  }
}

export class RufloMcpManager {
  readonly registry: RufloToolRegistry;
  private readonly auditLog: RufloToolAuditLog;
  private readonly configurations = new Map<string, RufloMcpServerConfiguration>();
  private readonly clients = new Map<string, RufloMcpClientLike>();
  private readonly approvals = new Map<string, ToolApproval>();
  private readonly usage = new Map<string, SessionUsage>();
  private readonly allowedServerNames: Set<string>;
  private readonly allowedCommands: Set<string>;
  private readonly allowedHosts: Set<string>;
  private readonly maxToolCalls: number;
  private readonly maxConcurrentCalls: number;
  private readonly isSessionOwned: (userId: string, sessionId: string) => boolean;
  private readonly clientFactory: (configuration: RufloMcpTransportConfiguration) => RufloMcpClientLike;

  constructor(options: RufloMcpManagerOptions = {}) {
    this.registry = options.registry ?? new RufloToolRegistry();
    this.auditLog = options.auditLog ?? rufloToolAuditLog;
    this.allowedServerNames = new Set(options.allowedServerNames ?? csv(process.env.RUFLO_MCP_ALLOWED_SERVERS));
    this.allowedCommands = new Set(options.allowedCommands ?? csv(process.env.RUFLO_MCP_ALLOWED_COMMANDS));
    this.allowedHosts = new Set(options.allowedHosts ?? csv(process.env.RUFLO_MCP_ALLOWED_HOSTS));
    this.maxToolCalls = bounded(options.maxToolCalls, 12, 1, 64);
    this.maxConcurrentCalls = bounded(options.maxConcurrentCalls, 2, 1, 8);
    this.isSessionOwned = options.isSessionOwned ?? (() => false);
    this.clientFactory = options.clientFactory ?? ((configuration) => new RufloMcpClient(configuration));
  }

  configure(input: Omit<RufloMcpServerConfiguration, "ownerId"> & { ownerId: string }): RufloMcpServerConfiguration {
    const configuration = normalizeConfiguration(input);
    if (!this.allowedServerNames.has(configuration.serverName)) {
      throw new RufloMcpManagerError("server_not_allowed", "This MCP server is not on the Ruflo server allowlist.");
    }
    validateTransport(configuration.transport, this.allowedCommands, this.allowedHosts);
    if (!configuration.allowedTools.length) throw new RufloMcpManagerError("invalid_configuration", "At least one exact MCP tool must be allowlisted.");
    if (configuration.toolPolicies && Object.keys(configuration.toolPolicies).some((name) => !configuration.allowedTools.includes(name))) {
      throw new RufloMcpManagerError("invalid_configuration", "MCP policies may only reference allowlisted tools.");
    }
    const key = this.serverKey(configuration.ownerId, configuration.serverName);
    const previous = this.configurations.get(key);
    this.configurations.set(key, cloneConfiguration(configuration));
    for (const tool of this.registry.list("mcp").filter((item) => item.ownerId === configuration.ownerId && item.serverName === configuration.serverName)) {
      if (!configuration.enabled || !configuration.allowedTools.includes(tool.name)) this.registry.setEnabled(tool.id, false);
    }
    if (previous && (!configuration.enabled || JSON.stringify(previous.transport) !== JSON.stringify(configuration.transport))) {
      void this.clients.get(key)?.close();
      this.clients.delete(key);
    }
    return cloneConfiguration(configuration);
  }

  list(ownerId: string, projectId?: string): RufloMcpServerConfiguration[] {
    return [...this.configurations.values()]
      .filter((configuration) => configuration.ownerId === ownerId && (!projectId || configuration.scope.type === "user" || configuration.scope.projectId === projectId))
      .map(cloneConfiguration);
  }

  get(ownerId: string, serverName: string, projectId?: string): RufloMcpServerConfiguration {
    const configuration = this.configurations.get(this.serverKey(ownerId, serverName));
    if (!configuration) throw new RufloMcpManagerError("server_not_found", "MCP server configuration was not found.");
    this.assertConfigurationScope(configuration, projectId);
    return cloneConfiguration(configuration);
  }

  async setEnabled(ownerId: string, serverName: string, enabled: boolean, projectId?: string): Promise<RufloMcpServerConfiguration> {
    const configuration = this.get(ownerId, serverName, projectId);
    const updated = this.configure({ ...configuration, enabled });
    if (!enabled) {
      await this.clients.get(this.serverKey(ownerId, serverName))?.close();
      this.clients.delete(this.serverKey(ownerId, serverName));
      for (const tool of this.registry.list("mcp").filter((item) => item.serverName === serverName && item.ownerId === ownerId)) this.registry.setEnabled(tool.id, enabled);
    }
    return updated;
  }

  async discover(ownerId: string, serverName: string, projectId?: string): Promise<RufloUnifiedToolDefinition[]> {
    const configuration = this.get(ownerId, serverName, projectId);
    if (!configuration.enabled) throw new RufloMcpManagerError("server_disabled", "The MCP server is disabled.");
    const key = this.serverKey(ownerId, serverName);
    const client = this.clientFactory(configuration.transport);
    try {
      await client.connect(Math.min(configuration.timeoutMs, 10_000));
      const discovered = await client.listTools(configuration.timeoutMs);
      const registered = discovered
        .filter((tool) => configuration.allowedTools.includes(tool.name))
        .map((tool) => this.registerDiscoveredTool(configuration, tool));
      if (!registered.length) throw new RufloMcpManagerError("tool_not_allowed", "The MCP server exposed no allowlisted tools.");
      await this.clients.get(key)?.close();
      this.clients.set(key, client);
      return registered;
    } catch (error) {
      await client.close();
      if (error instanceof RufloMcpManagerError) throw error;
      throw new RufloMcpManagerError("discovery_failed", safeErrorMessage(error, "MCP discovery failed."));
    }
  }

  approveTool(context: RufloMcpExecutionContext): { approvalId: string; toolId: string; expiresAt: string } {
    this.assertSession(context.userId, context.sessionId, context.projectId);
    const tool = this.getOwnedTool(context.userId, context.toolId, context.projectId);
    if (tool.riskLevel === "READ_ONLY" && !tool.approvalRequired) {
      throw new RufloMcpManagerError("invalid_approval", "Read-only MCP tools do not require approval.");
    }
    validateInput(tool, context.input);
    validateSafePathInputs(context.input);
    const approval: ToolApproval = {
      approvalId: randomUUID(),
      userId: context.userId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      toolId: tool.id,
      inputHash: hashInput(context.input),
      approvedAt: new Date().toISOString(),
    };
    this.approvals.set(approval.approvalId, approval);
    this.auditLog.record({
      sessionId: context.sessionId,
      taskId: context.taskId,
      userId: context.userId,
      toolId: tool.id,
      source: "mcp",
      mcpServer: tool.serverName,
      riskLevel: tool.riskLevel,
      approvalStatus: "approved",
      executionStatus: "authorized",
    });
    return { approvalId: approval.approvalId, toolId: tool.id, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  }

  async executeTool(context: RufloMcpExecutionContext & { toolId: string }): Promise<RufloToolExecutionResult> {
    let tool: RufloUnifiedToolDefinition | undefined;
    let approvalStatus: "not_required" | "approved" = "not_required";
    const startedAt = Date.now();
    try {
      this.assertSession(context.userId, context.sessionId, context.projectId);
      tool = this.getOwnedTool(context.userId, context.toolId, context.projectId);
      const configuration = this.get(context.userId, tool.serverName!, context.projectId);
      if (!configuration.enabled) throw new RufloMcpManagerError("server_disabled", "The MCP server is disabled.");
      validateInput(tool, context.input);
      validateSafePathInputs(context.input);
      if (tool.riskLevel !== "READ_ONLY" || tool.approvalRequired) {
        this.assertToolApproval(context, tool);
        approvalStatus = "approved";
      }
      this.registry.authorize(tool.id, context.input, {
        permissions: configuration.permissions,
        allowLowRisk: configuration.autoApproveLowRisk,
        approved: approvalStatus === "approved",
      });
      const usageKey = `${context.userId}:${context.sessionId}`;
      const current = this.usage.get(usageKey) ?? { calls: 0, active: 0 };
      if (current.calls >= this.maxToolCalls) throw new RufloMcpManagerError("limit", "The Ruflo MCP tool-call limit was reached.");
      if (current.active >= this.maxConcurrentCalls) throw new RufloMcpManagerError("limit", "The Ruflo MCP concurrency limit was reached.");
      current.calls += 1;
      current.active += 1;
      this.usage.set(usageKey, current);
      try {
        const client = this.clients.get(this.serverKey(context.userId, configuration.serverName));
        if (!client) throw new RufloMcpManagerError("execution_failed", "Discover the MCP server before executing a tool.");
        if (context.approvalId) this.approvals.delete(context.approvalId);
        let call: Awaited<ReturnType<RufloMcpClientLike["callTool"]>>;
        try {
          call = await withTimeout(
            client.callTool(tool.name, context.input, Math.min(configuration.timeoutMs, tool.timeoutMs)),
            Math.min(configuration.timeoutMs, tool.timeoutMs),
          );
        } catch (error) {
          if (error instanceof RufloMcpClientError && error.code === "timeout") {
            await client.close();
            this.clients.delete(this.serverKey(context.userId, configuration.serverName));
          }
          throw error;
        }
        if (call.isError) throw new RufloMcpManagerError("execution_failed", "The MCP server reported a tool failure.");
        if (tool.outputSchema && call.structuredContent !== undefined) validateJsonSchema(tool.outputSchema, call.structuredContent, "output");
        const output = call.structuredContent ?? { content: call.content ?? [] };
        const result: RufloToolExecutionResult = { ok: true, toolId: tool.id, serverName: configuration.serverName, toolName: tool.name, output, approvalStatus };
        this.recordAudit(context, tool, approvalStatus, "completed", startedAt);
        return result;
      } finally {
        current.active -= 1;
        this.usage.set(usageKey, current);
      }
    } catch (error) {
      const category = error instanceof RufloToolRegistryError
        ? error.code
        : error instanceof RufloMcpManagerError
          ? error.code
          : error instanceof RufloMcpClientError
            ? error.code
            : "execution_failed";
      const message = safeErrorMessage(error, "MCP tool execution failed.");
      if (tool) this.recordAudit(context, tool, category === "approval_required" ? "required" : category === "invalid_approval" ? "rejected" : approvalStatus, "failed", startedAt, category);
      const failureApprovalStatus: "required" | "rejected" | "not_required" =
        category === "approval_required" ? "required" : category === "invalid_approval" ? "rejected" : approvalStatus === "approved" ? "not_required" : approvalStatus;
      return {
        ok: false,
        toolId: context.toolId,
        error: { category, message },
        approvalStatus: failureApprovalStatus,
      };
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }

  private registerDiscoveredTool(configuration: RufloMcpServerConfiguration, tool: McpTool): RufloUnifiedToolDefinition {
    const policy = configuration.toolPolicies[tool.name] ?? {
      riskLevel: "HIGH" as const,
      permissions: ["mcp:read"] as RufloToolPermission[],
      approvalRequired: true,
    };
    const definition: RufloUnifiedToolDefinition = {
      id: mcpToolId(configuration.serverName, tool.name, configuration.ownerId),
      name: tool.name,
      description: `Untrusted MCP metadata: ${tool.description}`,
      source: "mcp",
      serverName: configuration.serverName,
      ownerId: configuration.ownerId,
      inputSchema: tool.inputSchema,
      outputSchema: policy.outputSchema ?? tool.outputSchema,
      permissions: [...policy.permissions],
      riskLevel: policy.riskLevel,
      timeoutMs: configuration.timeoutMs,
      enabled: configuration.enabled,
      approvalRequired: policy.riskLevel === "READ_ONLY" ? policy.approvalRequired === true : true,
    };
    return this.registry.registerOrReplace(definition);
  }

  private getOwnedTool(ownerId: string, toolId: string, projectId?: string): RufloUnifiedToolDefinition {
    const tool = this.registry.get(toolId);
    if (tool.source !== "mcp" || !tool.serverName || tool.ownerId !== ownerId) throw new RufloMcpManagerError("tool_not_found", "MCP tool was not found.");
    const configuration = this.get(ownerId, tool.serverName, projectId);
    if (!configuration.allowedTools.includes(tool.name)) throw new RufloMcpManagerError("tool_not_allowed", "MCP tool is no longer allowlisted.");
    return tool;
  }

  private assertToolApproval(context: RufloMcpExecutionContext, tool: RufloUnifiedToolDefinition): void {
    if (!context.approvalId) throw new RufloMcpManagerError("approval_required", "Explicit approval is required before this MCP tool can run.");
    const approval = this.approvals.get(context.approvalId);
    if (!approval || approval.userId !== context.userId || approval.sessionId !== context.sessionId || approval.toolId !== tool.id || (approval.taskId && approval.taskId !== context.taskId) || approval.inputHash !== hashInput(context.input)) {
      throw new RufloMcpManagerError("invalid_approval", "This approval does not authorize the requested MCP tool input.");
    }
    if (Date.now() - Date.parse(approval.approvedAt) > 10 * 60_000) throw new RufloMcpManagerError("invalid_approval", "This MCP tool approval has expired.");
  }

  private assertSession(userId: string, sessionId: string, projectId?: string): void {
    if (!userId.trim() || !sessionId.trim() || !this.isSessionOwned(userId, sessionId, projectId)) {
      throw new RufloMcpManagerError("session_unauthorized", "The Ruflo session is not owned by the authenticated user.");
    }
  }

  private assertConfigurationScope(configuration: RufloMcpServerConfiguration, projectId?: string): void {
    if (configuration.scope.type === "project" && configuration.scope.projectId !== projectId) {
      throw new RufloMcpManagerError("session_unauthorized", "The MCP server is not available in this Ruflo project.");
    }
  }

  private recordAudit(
    context: RufloMcpExecutionContext,
    tool: RufloUnifiedToolDefinition,
    approvalStatus: RufloToolExecutionResult["approvalStatus"],
    executionStatus: "completed" | "failed",
    startedAt: number,
    errorCategory?: string,
  ): void {
    this.auditLog.record({
      sessionId: context.sessionId,
      taskId: context.taskId,
      userId: context.userId,
      toolId: tool.id,
      source: "mcp",
      mcpServer: tool.serverName,
      riskLevel: tool.riskLevel,
      approvalStatus,
      executionStatus,
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCategory,
    });
  }

  private serverKey(ownerId: string, serverName: string): string {
    return `${ownerId}:${serverName}`;
  }
}

function normalizeConfiguration(input: Omit<RufloMcpServerConfiguration, "ownerId"> & { ownerId: string }): RufloMcpServerConfiguration {
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(input.serverName) || !input.ownerId.trim()) {
    throw new RufloMcpManagerError("invalid_configuration", "MCP server name or owner is invalid.");
  }
  if (input.scope.type === "project" && !/^[a-zA-Z0-9_-]{1,80}$/.test(input.scope.projectId)) {
    throw new RufloMcpManagerError("invalid_configuration", "MCP project scope is invalid.");
  }
  const allowedTools = [...new Set(input.allowedTools.filter((tool) => /^[a-zA-Z0-9_.:/-]{1,200}$/.test(tool)))].slice(0, 100);
  const permissions = [...new Set(input.permissions)].filter(isPermission);
  if (!permissions.length) throw new RufloMcpManagerError("invalid_configuration", "MCP configuration must grant an explicit permission.");
  const toolPolicies: Record<string, RufloMcpToolPolicy> = {};
  for (const [name, policy] of Object.entries(input.toolPolicies ?? {}).slice(0, 100)) {
    if (!allowedTools.includes(name) || !isRisk(policy.riskLevel) || !policy.permissions.every(isPermission)) continue;
    toolPolicies[name] = {
      riskLevel: policy.riskLevel,
      permissions: [...new Set(policy.permissions)],
      approvalRequired: policy.approvalRequired === true,
      outputSchema: policy.outputSchema,
    };
  }
  return {
    serverName: input.serverName,
    ownerId: input.ownerId.slice(0, 200),
    scope: input.scope.type === "project" ? { type: "project", projectId: input.scope.projectId } : { type: "user" },
    transport: input.transport.type === "stdio"
      ? { type: "stdio", command: input.transport.command, args: input.transport.args.slice(0, 32) }
      : { type: "streamable-http", url: input.transport.url },
    enabled: input.enabled === true,
    allowedTools,
    toolPolicies,
    permissions,
    timeoutMs: bounded(input.timeoutMs, 12_000, 1_000, 60_000),
    autoApproveLowRisk: input.autoApproveLowRisk === true,
  };
}

function validateTransport(configuration: RufloMcpTransportConfiguration, allowedCommands: Set<string>, allowedHosts: Set<string>): void {
  if (configuration.type === "stdio") {
    if (!/^[a-zA-Z0-9_./-]{1,200}$/.test(configuration.command) || configuration.command.includes("..") || !allowedCommands.has(configuration.command)) {
      throw new RufloMcpManagerError("server_not_allowed", "MCP stdio commands must be explicitly allowlisted and cannot use shell syntax.");
    }
    if (configuration.args.some((arg) => arg.length > 500 || /(?:^|[\s])(?:-e|-c|--eval|--require|--import)(?:[\s=]|$)/.test(arg))) {
      throw new RufloMcpManagerError("invalid_configuration", "MCP stdio arguments contain unsafe execution flags.");
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(configuration.url);
  } catch {
    throw new RufloMcpManagerError("invalid_configuration", "MCP HTTP URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.has(url.hostname)) {
    throw new RufloMcpManagerError("server_not_allowed", "MCP HTTP servers must use an allowlisted HTTPS host without embedded credentials.");
  }
}

function validateInput(tool: RufloUnifiedToolDefinition, input: unknown): void {
  try {
    validateJsonSchema(tool.inputSchema, input, "input");
  } catch (error) {
    if (error instanceof RufloToolRegistryError && error.code === "schema_invalid") {
      throw new RufloMcpManagerError("schema_invalid", error.message);
    }
    throw error;
  }
}

function validateSafePathInputs(value: unknown, depth = 0): void {
  if (depth > 6) throw new RufloMcpManagerError("schema_invalid", "MCP input nesting exceeds the safety limit.");
  if (Array.isArray(value)) {
    value.forEach((item) => validateSafePathInputs(item, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && /^(path|filePath|directory|fromPath|toPath|workspacePath)$/i.test(key)) {
      try {
        safeWorkspaceRelative(item);
      } catch {
        throw new RufloMcpManagerError("schema_invalid", `Unsafe workspace path rejected for MCP input "${key}".`);
      }
    } else {
      validateSafePathInputs(item, depth + 1);
    }
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new RufloMcpClientError("timeout", "MCP tool execution timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cloneConfiguration(configuration: RufloMcpServerConfiguration): RufloMcpServerConfiguration {
  return {
    ...configuration,
    scope: { ...configuration.scope },
    transport: { ...configuration.transport, ...(configuration.transport.type === "stdio" ? { args: [...configuration.transport.args] } : {}) } as RufloMcpTransportConfiguration,
    allowedTools: [...configuration.allowedTools],
    permissions: [...configuration.permissions],
    toolPolicies: Object.fromEntries(Object.entries(configuration.toolPolicies).map(([name, policy]) => [name, { ...policy, permissions: [...policy.permissions] }])),
  };
}

function hashInput(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function safeErrorMessage(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : fallback;
  const redacted = redactMcpValue(value);
  return typeof redacted === "string" ? redacted.slice(0, 500) : fallback;
}

function isPermission(value: unknown): value is RufloToolPermission {
  return ["repository:read", "workspace:read", "mcp:read", "mcp:write", "network:outbound"].includes(String(value));
}

function isRisk(value: unknown): value is RufloRiskLevel {
  return ["READ_ONLY", "LOW", "MEDIUM", "HIGH", "DESTRUCTIVE"].includes(String(value));
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback;
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}