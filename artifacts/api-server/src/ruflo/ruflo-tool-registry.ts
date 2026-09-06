import { RUFLO_PHASE9_IMPORTED_TOOLS } from "./ruflo-phase9-catalog";
import { RUFLO_PHASE10_TOOL_DEFINITIONS } from "./ruflo-phase10-catalog";
import {
  RUFLO_PHASE11_NATIVE_TOOL_DEFINITIONS,
  RUFLO_PHASE11_PLUGIN_TOOL_DEFINITIONS,
} from "./ruflo-phase11-native";

export const RUFLO_RISK_LEVELS = [
  "READ_ONLY",
  "LOW",
  "MEDIUM",
  "HIGH",
  "DESTRUCTIVE",
] as const;

export type RufloRiskLevel = (typeof RUFLO_RISK_LEVELS)[number];
export type RufloToolSource = "ruflo" | "mcp";
export type RufloToolPermission =
  | "repository:read"
  | "workspace:read"
  | "memory:read"
  | "memory:write"
  | "terminal:execute"
  | "mcp:read"
  | "mcp:write"
  | "network:outbound";

export type RufloImplementationKind = "native" | "cosmic-adapter" | "metadata-only" | "disabled";
export type RufloExecutionMode = "in_process_read_only" | "in_process_bounded" | "bounded_subprocess" | "network_read_only" | "metadata";
export type RufloTestStatus = "verified" | "partial" | "unverified";
export type RufloParityStatus = "verified" | "partial" | "metadata-only" | "disabled" | "not-verified";

export type RufloJsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, RufloJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: RufloJsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
};

export type RufloUnifiedToolDefinition = {
  id: string;
  name: string;
  description: string;
  source: RufloToolSource;
  serverName?: string;
  ownerId?: string;
  inputSchema: RufloJsonSchema;
  outputSchema?: RufloJsonSchema;
  permissions: RufloToolPermission[];
  riskLevel: RufloRiskLevel;
  timeoutMs: number;
  enabled: boolean;
  approvalRequired: boolean;
  provenance?: {
    originalRepository: string;
    originalRevision: string;
    sourcePath: string;
    license: "MIT";
    reuseMode: "adapted" | "native" | "metadata_only";
    originalToolName?: string;
  };
  implementationKind?: RufloImplementationKind;
  originalSource?: string;
  originalRevision?: string;
  originalBehaviorReference?: string;
  cosmicImplementation?: string;
  risk?: RufloRiskLevel;
  executionMode?: RufloExecutionMode;
  testStatus?: RufloTestStatus;
  parityStatus?: RufloParityStatus;
  agentAccess?: {
    rufloOnly: true;
    allowedAgentTypes: string[];
  };
  resourceLimits?: {
    maxInputBytes: number;
    maxOutputBytes: number;
    maxResults: number;
    maxConcurrentCalls: number;
  };
  executionAdapter?: "native" | "safe_plugin" | "bounded_evidence" | "sandboxed_terminal" | "safe_browser" | "disabled";
  availability?: "enabled" | "disabled";
};

export type RufloToolPolicyContext = {
  permissions: RufloToolPermission[];
  allowLowRisk: boolean;
  approved: boolean;
};

export class RufloToolRegistryError extends Error {
  constructor(
    readonly code:
      | "invalid_definition"
      | "duplicate_tool"
      | "tool_not_found"
      | "tool_disabled"
      | "permission_denied"
      | "approval_required"
      | "schema_invalid"
      | "resource_limit"
      | "execution_timeout",
    message: string,
  ) {
    super(message);
    this.name = "RufloToolRegistryError";
  }
}

export class RufloToolRegistry {
  private readonly tools = new Map<string, RufloUnifiedToolDefinition>();

  register(definition: RufloUnifiedToolDefinition): RufloUnifiedToolDefinition {
    validateDefinition(definition);
    if (this.tools.has(definition.id)) {
      throw new RufloToolRegistryError("duplicate_tool", `Ruflo tool "${definition.id}" is already registered.`);
    }
    const copy = normalizeDefinition(definition);
    this.tools.set(copy.id, copy);
    return cloneDefinition(copy);
  }

  registerOrReplace(definition: RufloUnifiedToolDefinition): RufloUnifiedToolDefinition {
    validateDefinition(definition);
    const copy = normalizeDefinition(definition);
    this.tools.set(copy.id, copy);
    return cloneDefinition(copy);
  }

  get(id: string): RufloUnifiedToolDefinition {
    const tool = this.tools.get(id);
    if (!tool) throw new RufloToolRegistryError("tool_not_found", `Ruflo tool "${id}" is not registered.`);
    return cloneDefinition(tool);
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  list(source?: RufloToolSource): RufloUnifiedToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => !source || tool.source === source)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneDefinition);
  }

  setEnabled(id: string, enabled: boolean): RufloUnifiedToolDefinition {
    const tool = this.get(id);
    return this.registerOrReplace({ ...tool, enabled });
  }

  authorize(id: string, input: unknown, context: RufloToolPolicyContext): RufloUnifiedToolDefinition {
    const tool = this.get(id);
    if (!tool.enabled) throw new RufloToolRegistryError("tool_disabled", `Ruflo tool "${id}" is disabled.`);
    if (!tool.permissions.every((permission) => context.permissions.includes(permission))) {
      throw new RufloToolRegistryError("permission_denied", `Permission denied for Ruflo tool "${id}".`);
    }
    validateJsonSchema(tool.inputSchema, input, "input");
    if (tool.riskLevel === "LOW" && !context.allowLowRisk) {
      throw new RufloToolRegistryError("approval_required", `Ruflo policy requires approval for low-risk tool "${id}".`);
    }
    if (tool.approvalRequired || tool.riskLevel === "MEDIUM" || tool.riskLevel === "HIGH" || tool.riskLevel === "DESTRUCTIVE") {
      if (!context.approved) {
        throw new RufloToolRegistryError("approval_required", `Explicit approval is required for Ruflo tool "${id}".`);
      }
    }
    return tool;
  }
}

export function createDefaultRufloToolRegistry(): RufloToolRegistry {
  const registry = new RufloToolRegistry();
  for (const id of ["phase10_catalog", "phase10_provenance", "phase10_limits", "phase10_security", "phase10_audit"]) {
    registry.register({
      id,
      name: id,
      description: "Report the verified Phase 10 Ruflo inventory and server-owned security boundaries.",
      source: "ruflo",
      inputSchema: { type: "object", properties: { includeDisabled: { type: "boolean" }, sessionId: { type: "string", maxLength: 120 } }, additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true },
      permissions: ["workspace:read"],
      riskLevel: "READ_ONLY",
      timeoutMs: 5_000,
      enabled: true,
      approvalRequired: false,
      agentAccess: { rufloOnly: true, allowedAgentTypes: ["coordinator", "security-auditor", "researcher"] },
      resourceLimits: { maxInputBytes: 2_000, maxOutputBytes: 32_000, maxResults: 64, maxConcurrentCalls: 4 },
    });
  }
  registry.register({
    id: "inspect_repository",
    name: "inspect_repository",
    description: "Inspect bounded repository or workspace metadata and relevant files.",
    source: "ruflo",
    inputSchema: objectSchema({
      path: { type: "string", minLength: 1, maxLength: 500 },
    }, []),
    outputSchema: { type: "object", additionalProperties: true },
    permissions: ["repository:read", "workspace:read"],
    riskLevel: "READ_ONLY",
    timeoutMs: 12_000,
    enabled: true,
    approvalRequired: false,
  });
  registry.register({
    id: "search_repository",
    name: "search_repository",
    description: "Search bounded repository or workspace text.",
    source: "ruflo",
    inputSchema: objectSchema({
      query: { type: "string", minLength: 1, maxLength: 240 },
    }, ["query"]),
    outputSchema: { type: "array", items: { type: "object", additionalProperties: true }, maxItems: 100 },
    permissions: ["repository:read", "workspace:read"],
    riskLevel: "READ_ONLY",
    timeoutMs: 12_000,
    enabled: true,
    approvalRequired: false,
  });
  registry.register({
    id: "read_file",
    name: "read_file",
    description: "Read one bounded text file inside the selected repository or workspace.",
    source: "ruflo",
    inputSchema: objectSchema({
      path: { type: "string", minLength: 1, maxLength: 500 },
    }, ["path"]),
    outputSchema: { type: "object", additionalProperties: true },
    permissions: ["repository:read", "workspace:read"],
    riskLevel: "READ_ONLY",
    timeoutMs: 12_000,
    enabled: true,
    approvalRequired: false,
  });
  // Phase 9 adds only adapters whose execution can be routed through existing
  // repository, workspace, memory, audit, and budget boundaries.
  for (const definition of RUFLO_PHASE9_IMPORTED_TOOLS) registry.register(definition);
  // Phase 10 remains on the same unified registry. Phase 9 identifiers are
  // already canonical and must not be registered a second time.
  for (const definition of RUFLO_PHASE10_TOOL_DEFINITIONS) {
    if (!registry.has(definition.id)) registry.register(definition);
  }
  for (const definition of RUFLO_PHASE11_NATIVE_TOOL_DEFINITIONS) registry.registerOrReplace(definition);
  for (const definition of RUFLO_PHASE11_PLUGIN_TOOL_DEFINITIONS) registry.registerOrReplace(definition);
  return registry;
}

export function mcpToolId(serverName: string, toolName: string, ownerId?: string): string {
  return `mcp:${safeIdentifier(ownerId ?? "shared")}:${safeIdentifier(serverName)}:${safeIdentifier(toolName)}`;
}

export function validateJsonSchema(schema: RufloJsonSchema, value: unknown, label = "value"): void {
  validateSchemaNode(schema, value, label, 0);
}

function validateSchemaNode(schema: RufloJsonSchema, value: unknown, label: string, depth: number): void {
  if (depth > 8) throw new RufloToolRegistryError("schema_invalid", `${label} exceeds the schema nesting limit.`);
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    throw new RufloToolRegistryError("schema_invalid", `${label} is not an allowed value.`);
  }
  if (schema.type) {
    const valid = schema.type === "null"
      ? value === null
      : schema.type === "array"
        ? Array.isArray(value)
        : schema.type === "object"
          ? isRecord(value)
          : schema.type === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : typeof value === schema.type;
    if (!valid) throw new RufloToolRegistryError("schema_invalid", `${label} has an invalid type.`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new RufloToolRegistryError("schema_invalid", `${label} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new RufloToolRegistryError("schema_invalid", `${label} is too long.`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new RufloToolRegistryError("schema_invalid", `${label} has too many items.`);
    if (schema.items) value.forEach((item, index) => validateSchemaNode(schema.items!, item, `${label}[${index}]`, depth + 1));
  }
  if (isRecord(value) && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw new RufloToolRegistryError("schema_invalid", `${label}.${key} is required.`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties[key]) validateSchemaNode(schema.properties[key], child, `${label}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new RufloToolRegistryError("schema_invalid", `${label}.${key} is not allowed.`);
    }
  }
}

function objectSchema(properties: Record<string, RufloJsonSchema>, required: string[]): RufloJsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function validateDefinition(definition: RufloUnifiedToolDefinition): void {
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(definition.id) || !definition.name.trim()) {
    throw new RufloToolRegistryError("invalid_definition", "Ruflo tools require a bounded identifier and name.");
  }
  if (definition.source === "mcp" && !definition.serverName) {
    throw new RufloToolRegistryError("invalid_definition", "MCP tools must identify their server.");
  }
  if (!RUFLO_RISK_LEVELS.includes(definition.riskLevel) || !Number.isFinite(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > 120_000) {
    throw new RufloToolRegistryError("invalid_definition", `Ruflo tool "${definition.id}" has an invalid risk or timeout.`);
  }
  if (definition.permissions.length === 0) {
    throw new RufloToolRegistryError("invalid_definition", `Ruflo tool "${definition.id}" must declare permissions.`);
  }
}

function normalizeDefinition(definition: RufloUnifiedToolDefinition): RufloUnifiedToolDefinition {
  const disabled = definition.enabled === false || definition.availability === "disabled" || definition.executionAdapter === "disabled";
  const implementationKind = definition.implementationKind
    ?? (disabled ? (definition.executionAdapter === "disabled" ? "disabled" : definition.provenance?.reuseMode === "metadata_only" ? "metadata-only" : "disabled")
      : definition.executionAdapter === "bounded_evidence" ? "cosmic-adapter" : "cosmic-adapter");
  return {
    ...definition,
    implementationKind,
    originalSource: definition.originalSource ?? definition.provenance?.sourcePath ?? "cosmic-agent",
    originalRevision: definition.originalRevision ?? definition.provenance?.originalRevision ?? "not-applicable",
    originalBehaviorReference: definition.originalBehaviorReference
      ?? (definition.provenance?.originalToolName
        ? `${definition.provenance.sourcePath} :: ${definition.provenance.originalToolName}`
        : "No original behavior reference; Cosmic capability only."),
    cosmicImplementation: definition.cosmicImplementation ?? definition.executionAdapter ?? "server-owned",
    risk: definition.risk ?? definition.riskLevel,
    resourceLimits: definition.resourceLimits ?? {
      maxInputBytes: 12_000,
      maxOutputBytes: 32_000,
      maxResults: 48,
      maxConcurrentCalls: 2,
    },
    executionMode: definition.executionMode
      ?? (definition.executionAdapter === "safe_browser" ? "network_read_only"
        : definition.executionAdapter === "sandboxed_terminal" ? "bounded_subprocess"
          : disabled ? "metadata" : "in_process_bounded"),
    testStatus: definition.testStatus ?? "unverified",
    parityStatus: definition.parityStatus
      ?? (disabled ? (implementationKind === "metadata-only" ? "metadata-only" : "disabled") : "partial"),
  };
}

function cloneDefinition(definition: RufloUnifiedToolDefinition): RufloUnifiedToolDefinition {
  return {
    ...definition,
    permissions: [...definition.permissions],
    inputSchema: structuredClone(definition.inputSchema),
    outputSchema: definition.outputSchema ? structuredClone(definition.outputSchema) : undefined,
    provenance: definition.provenance ? { ...definition.provenance } : undefined,
    agentAccess: definition.agentAccess
      ? { rufloOnly: true, allowedAgentTypes: [...definition.agentAccess.allowedAgentTypes] }
      : undefined,
    resourceLimits: definition.resourceLimits ? { ...definition.resourceLimits } : undefined,
  };
}

function safeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unnamed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}