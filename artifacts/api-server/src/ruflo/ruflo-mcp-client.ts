import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { redactGitSensitive } from "../repository/git-security";
import type { RufloJsonSchema } from "./ruflo-tool-registry";

export type RufloMcpTransportConfiguration =
  | { type: "stdio"; command: string; args: string[] }
  | { type: "streamable-http"; url: string };

export type McpTool = {
  name: string;
  description: string;
  inputSchema: RufloJsonSchema;
  outputSchema?: RufloJsonSchema;
};

export type McpCallResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

export class RufloMcpClientError extends Error {
  constructor(
    readonly code: "transport" | "timeout" | "protocol" | "server" | "unsupported_transport",
    message: string,
  ) {
    super(message);
    this.name = "RufloMcpClientError";
  }
}

export interface RufloMcpJsonRpcConnection {
  connect(): Promise<void>;
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export class RufloMcpClient {
  private connected = false;

  constructor(
    private readonly transport: RufloMcpTransportConfiguration,
    private readonly connection: RufloMcpJsonRpcConnection = createConnection(transport),
  ) {}

  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.connected) return;
    try {
      await this.connection.connect();
      await this.connection.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ruflo", version: "1.0" },
      }, timeoutMs);
      await this.connection.notify("notifications/initialized", {});
      this.connected = true;
    } catch (error) {
      await this.close();
      throw asMcpError(error, "MCP initialization failed.");
    }
  }

  async listTools(timeoutMs = 10_000): Promise<McpTool[]> {
    this.assertConnected();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 16; page += 1) {
      const result = await this.connection.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      if (!isRecord(result) || !Array.isArray(result.tools)) throw new RufloMcpClientError("protocol", "MCP tools/list returned an invalid result.");
      for (const item of result.tools.slice(0, 200 - tools.length)) tools.push(parseTool(item));
      if (tools.length >= 200 || typeof result.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor.slice(0, 500);
    }
    return tools;
  }

  async callTool(name: string, argumentsValue: unknown, timeoutMs = 12_000): Promise<McpCallResult> {
    this.assertConnected();
    if (!/^[a-zA-Z0-9_.:/-]{1,200}$/.test(name)) throw new RufloMcpClientError("protocol", "MCP tool name is invalid.");
    const result = await this.connection.request("tools/call", {
      name,
      arguments: argumentsValue,
    }, timeoutMs);
    if (!isRecord(result)) throw new RufloMcpClientError("protocol", "MCP tools/call returned an invalid result.");
    return {
      content: Array.isArray(result.content) ? result.content.slice(0, 100).map(redactMcpValue) : undefined,
      structuredContent: "structuredContent" in result ? redactMcpValue(result.structuredContent) : undefined,
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.connection.close().catch(() => undefined);
  }

  private assertConnected(): void {
    if (!this.connected) throw new RufloMcpClientError("transport", "MCP client is not connected.");
  }
}

export function parseMcpTool(value: unknown): McpTool {
  return parseTool(value);
}

export function redactMcpValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    return redactSecrets(redactGitSensitive(value)).slice(0, 16_000);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactMcpValue(item, depth + 1));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/(api[_-]?key|token|secret|password|cookie|authorization|private[_-]?key|credential)/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactMcpValue(item, depth + 1);
    }
  }
  return result;
}

function createConnection(configuration: RufloMcpTransportConfiguration): RufloMcpJsonRpcConnection {
  if (configuration.type === "stdio") return new StdioJsonRpcConnection(configuration);
  return new StreamableHttpJsonRpcConnection(configuration.url);
}

class StdioJsonRpcConnection implements RufloMcpJsonRpcConnection {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timeout: ReturnType<typeof setTimeout> }>();

  constructor(private readonly configuration: Extract<RufloMcpTransportConfiguration, { type: "stdio" }>) {}

  async connect(): Promise<void> {
    if (this.child) return;
    if (!this.configuration.command || this.configuration.args.length > 32) throw new RufloMcpClientError("transport", "MCP stdio configuration is invalid.");
    this.child = spawn(this.configuration.command, this.configuration.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeChildEnvironment(),
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.on("error", (error) => this.failPending(new RufloMcpClientError("transport", error.message)));
    this.child.on("exit", () => {
      this.child = undefined;
      this.failPending(new RufloMcpClientError("transport", "MCP stdio server exited."));
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.child?.stdin.writable) return Promise.reject(new RufloMcpClientError("transport", "MCP stdio server is unavailable."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new RufloMcpClientError("timeout", `MCP request "${method}" timed out.`));
        void this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new RufloMcpClientError("transport", "MCP request could not be sent."));
        }
      });
    });
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.child?.stdin.writable) throw new RufloMcpClientError("transport", "MCP stdio server is unavailable.");
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, (error) => error ? reject(new RufloMcpClientError("transport", "MCP notification could not be sent.")) : resolve());
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill("SIGTERM");
    this.failPending(new RufloMcpClientError("transport", "MCP connection closed."));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4_000_000) {
      this.buffer = "";
      void this.close();
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (isRecord(message.error)) {
      pending.reject(new RufloMcpClientError("server", String(message.error.message ?? "MCP server rejected the request.").slice(0, 500)));
    } else {
      pending.resolve(message.result);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class StreamableHttpJsonRpcConnection implements RufloMcpJsonRpcConnection {
  private sequence = 0;
  private readonly controller = new AbortController();

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    // The first JSON-RPC request is sent by RufloMcpClient.initialize().
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.sequence, method, params }),
        signal: controller.signal,
      });
      if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        throw new RufloMcpClientError("unsupported_transport", "SSE MCP transport is not enabled in Ruflo.");
      }
      if (!response.ok) throw new RufloMcpClientError("transport", `MCP server returned HTTP ${response.status}.`);
      const message = await response.json() as unknown;
      if (!isRecord(message) || "error" in message) throw new RufloMcpClientError("server", "MCP server returned a JSON-RPC error.");
      return message.result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new RufloMcpClientError("timeout", `MCP request "${method}" timed out.`);
      throw asMcpError(error, "MCP HTTP request failed.");
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(): Promise<void> {
    // Streamable HTTP notifications are intentionally not sent separately.
  }

  async close(): Promise<void> {
    this.controller.abort();
  }
}

function parseTool(value: unknown): McpTool {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.inputSchema)) {
    throw new RufloMcpClientError("protocol", "MCP discovery returned an invalid tool schema.");
  }
  if (value.name.length > 200) throw new RufloMcpClientError("protocol", "MCP tool name is too long.");
  const inputSchema = normalizeSchema(value.inputSchema);
  return {
    name: value.name.slice(0, 200),
    description: typeof value.description === "string" ? redactSecrets(value.description).slice(0, 2_000) : "Untrusted MCP tool.",
    inputSchema,
    outputSchema: isRecord(value.outputSchema) ? normalizeSchema(value.outputSchema) : undefined,
  };
}

function normalizeSchema(value: Record<string, unknown>): RufloJsonSchema {
  const type = value.type;
  if (type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type))) {
    throw new RufloMcpClientError("protocol", "MCP schema contains an unsupported type.");
  }
  const schema: RufloJsonSchema = { type: type as RufloJsonSchema["type"] | undefined };
  if (isRecord(value.properties)) {
    schema.properties = {};
    for (const [key, child] of Object.entries(value.properties).slice(0, 100)) {
      if (!isRecord(child)) throw new RufloMcpClientError("protocol", "MCP schema property is invalid.");
      schema.properties[key.slice(0, 100)] = normalizeSchema(child);
    }
  }
  if (Array.isArray(value.required)) schema.required = value.required.filter((item): item is string => typeof item === "string").slice(0, 100);
  if (typeof value.additionalProperties === "boolean") schema.additionalProperties = value.additionalProperties;
  if (isRecord(value.items)) schema.items = normalizeSchema(value.items);
  if (Array.isArray(value.enum)) schema.enum = value.enum.slice(0, 100);
  for (const key of ["minLength", "maxLength", "maxItems"] as const) {
    if (typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= 0) schema[key] = value[key];
  }
  return schema;
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_ENV"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]");
}

function asMcpError(error: unknown, fallback: string): RufloMcpClientError {
  if (error instanceof RufloMcpClientError) return error;
  return new RufloMcpClientError("transport", error instanceof Error ? error.message.slice(0, 500) : fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}