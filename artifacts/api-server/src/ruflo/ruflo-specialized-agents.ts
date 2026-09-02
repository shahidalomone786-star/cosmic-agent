import { randomUUID } from "node:crypto";
import type { ChangeProposal } from "../ai/change-proposal";
import type { RufloAgentExecution, RufloAgentRole } from "./ruflo-agents";
import {
  RufloDynamicDagScheduler,
  type RufloSwarmLimits,
  type RufloSwarmResult,
  type RufloSwarmTask,
  type RufloTaskOperation,
} from "./ruflo-dag";
import { sanitizeMemoryFact } from "./memory-policy";
import type { RufloMemoryKind } from "./types";

export type RufloSpecializedAgentRole =
  | "test_generator"
  | "documentation"
  | "git_intelligence"
  | "browser";

export type RufloSpecializedRole = RufloAgentRole | RufloSpecializedAgentRole;

export type RufloSpecializedInspectionFile = {
  path: string;
  kind: "source" | "test" | "documentation" | "configuration" | "other";
  content?: string;
};

export type RufloSpecializedInspection = {
  files: RufloSpecializedInspectionFile[];
  projectStructure?: string;
  apiBehavior?: string;
  references?: string[];
};

export type RufloSpecializedInspectRequest = {
  task: string;
  selectedFiles: string[];
  maxFiles: number;
  include: Array<RufloSpecializedInspectionFile["kind"]>;
};

export type RufloProposalRequest = {
  task: string;
  paths: string[];
  context: string;
  sourceRole: "test_generator" | "documentation";
};

export type RufloSpecializedAgentResult = {
  role: RufloSpecializedAgentRole;
  status: "completed" | "failed" | "unavailable";
  summary: string;
  readFiles: string[];
  changedFiles: string[];
  proposedFiles?: string[];
  references: string[];
  proposal?: ChangeProposal;
  analysis?: Record<string, unknown>;
  error?: string;
};

export type RufloTestGeneratorInput = {
  task: string;
  selectedFiles: string[];
  inspect: (request: RufloSpecializedInspectRequest) => Promise<RufloSpecializedInspection>;
  createProposal: (request: RufloProposalRequest) => Promise<ChangeProposal>;
};

export class RufloTestGeneratorAgent {
  async run(input: RufloTestGeneratorInput): Promise<RufloSpecializedAgentResult> {
    const inspection = await input.inspect({
      task: input.task,
      selectedFiles: input.selectedFiles,
      maxFiles: 24,
      include: ["source", "test", "configuration"],
    });
    const sourceFiles = inspection.files.filter((file) => file.kind === "source");
    const testFiles = inspection.files.filter((file) => file.kind === "test");
    const gaps = identifyTestGaps(sourceFiles, testFiles);
    const paths = uniquePaths([...sourceFiles, ...testFiles].map((file) => file.path));
    if (!paths.length) {
      return specializedFailure("No bounded source or test files were available for test analysis.", []);
    }

    const proposal = await input.createProposal({
      sourceRole: "test_generator",
      task: [
        input.task,
        "Generate focused tests only for the identified coverage gaps.",
        `Coverage gaps: ${gaps.join("; ") || "No direct source/test pairing was established; add focused regression coverage from the inspected behavior."}`,
      ].join("\n"),
      paths,
      context: boundedInspectionContext(inspection),
    });
    return {
      role: "test_generator",
      status: "completed",
      summary: `Identified ${gaps.length} bounded coverage gap(s) and generated a proposal for ${proposal.affectedFiles.length} file(s).`,
      readFiles: paths,
      changedFiles: uniquePaths(proposal.affectedFiles),
      references: boundedReferences(inspection),
      proposal,
      analysis: {
        sourceFiles: sourceFiles.map((file) => file.path).slice(0, 24),
        testFiles: testFiles.map((file) => file.path).slice(0, 24),
        coverageGaps: gaps,
      },
    };
  }
}

export type RufloDocumentationInput = {
  task: string;
  selectedFiles: string[];
  inspect: (request: RufloSpecializedInspectRequest) => Promise<RufloSpecializedInspection>;
  createProposal: (request: RufloProposalRequest) => Promise<ChangeProposal>;
};

export class RufloDocumentationAgent {
  async run(input: RufloDocumentationInput): Promise<RufloSpecializedAgentResult> {
    const inspection = await input.inspect({
      task: input.task,
      selectedFiles: input.selectedFiles,
      maxFiles: 24,
      include: ["source", "documentation", "configuration"],
    });
    const sourceFiles = inspection.files.filter((file) => file.kind === "source");
    const documentationFiles = inspection.files.filter((file) => file.kind === "documentation");
    const gaps = identifyDocumentationGaps(sourceFiles, documentationFiles, inspection.apiBehavior);
    const paths = uniquePaths([...sourceFiles, ...documentationFiles].map((file) => file.path));
    if (!paths.length) {
      return specializedFailure("No bounded source or documentation files were available for documentation analysis.", []);
    }

    const proposal = await input.createProposal({
      sourceRole: "documentation",
      task: [
        input.task,
        "Update only documentation that is directly supported by the inspected project behavior.",
        `Documentation gaps: ${gaps.join("; ") || "Check the inspected API and architecture behavior for narrowly scoped omissions."}`,
        "Do not rewrite unrelated documentation.",
      ].join("\n"),
      paths,
      context: boundedInspectionContext(inspection),
    });
    return {
      role: "documentation",
      status: "completed",
      summary: `Identified ${gaps.length} bounded documentation gap(s) and generated a proposal for ${proposal.affectedFiles.length} file(s).`,
      readFiles: paths,
      changedFiles: uniquePaths(proposal.affectedFiles),
      references: boundedReferences(inspection),
      proposal,
      analysis: {
        sourceFiles: sourceFiles.map((file) => file.path).slice(0, 24),
        documentationFiles: documentationFiles.map((file) => file.path).slice(0, 24),
        documentationGaps: gaps,
      },
    };
  }
}

export type RufloGitSnapshot = {
  status: { branch?: string; clean?: boolean; stagedFiles?: string[] };
  branches: string[];
  commits: Array<{ sha: string; message: string; author?: string; date?: string }>;
  diffs: Array<{ path: string; status: string; additions: number; deletions: number }>;
  changedFiles: string[];
  references?: string[];
};

export type RufloGitIntelligenceInput = {
  task: string;
  read: (task: string) => Promise<RufloGitSnapshot>;
};

export class RufloGitIntelligenceAgent {
  async run(input: RufloGitIntelligenceInput): Promise<RufloSpecializedAgentResult> {
    const snapshot = await input.read(input.task);
    const safe = sanitizeGitSnapshot(snapshot);
    return {
      role: "git_intelligence",
      status: "completed",
      summary: `Analyzed repository status, ${safe.branches.length} branch(es), ${safe.commits.length} recent commit(s), and ${safe.diffs.length} diff file(s).`,
      readFiles: safe.changedFiles,
      changedFiles: [],
      references: uniqueStrings([...(safe.references ?? []), ...safe.changedFiles]),
      analysis: safe as unknown as Record<string, unknown>,
    };
  }
}

export type RufloBrowserAction = {
  type: "click" | "fill" | "press";
  selector?: string;
  value?: string;
};

export type RufloBrowserDriver = {
  navigate: (url: string, signal: AbortSignal) => Promise<{ url: string; title?: string }>;
  inspect: (signal: AbortSignal) => Promise<{ text?: string; links?: string[]; forms?: string[] }>;
  act: (action: RufloBrowserAction, signal: AbortSignal) => Promise<{ ok: boolean; message?: string }>;
};

export type RufloBrowserInput = {
  task: string;
  urls: string[];
  actions?: RufloBrowserAction[];
  allowedOrigins: string[];
  driver?: RufloBrowserDriver;
  timeoutMs?: number;
};

export class RufloBrowserPolicyError extends Error {
  constructor(readonly code: "invalid_url" | "domain_not_allowed" | "limit") {
    super(code === "domain_not_allowed" ? "The browser URL is outside Ruflo's configured domain allowlist." : "The browser request is outside Ruflo's bounded policy.");
    this.name = "RufloBrowserPolicyError";
  }
}

export class RufloBrowserAgent {
  async run(input: RufloBrowserInput): Promise<RufloSpecializedAgentResult> {
    if (input.urls.length > 8) throw new RufloBrowserPolicyError("limit");
    const urls = uniqueStrings(input.urls).slice(0, 8);
    const allowedOrigins = input.allowedOrigins.map(normalizeOrigin).filter(Boolean);
    if (!urls.length || !allowedOrigins.length) throw new RufloBrowserPolicyError("invalid_url");
    if (urls.length > 8 || (input.actions?.length ?? 0) > 30) throw new RufloBrowserPolicyError("limit");
    for (const url of urls) assertAllowedBrowserUrl(url, allowedOrigins);
    if (!input.driver) {
      return {
        role: "browser",
        status: "unavailable",
        summary: "No browser automation driver is installed; the safe Ruflo browser abstraction accepted the bounded request without browsing.",
        readFiles: [],
        changedFiles: [],
        references: urls,
        analysis: { urls, actions: (input.actions ?? []).length, driver: "unavailable" },
      };
    }

    const timeoutMs = clamp(input.timeoutMs, 1_000, 60_000, 15_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const pages: Array<Record<string, unknown>> = [];
      for (const url of urls) {
        const navigation = await withBrowserTimeout(input.driver.navigate(url, controller.signal), timeoutMs, controller);
        const inspection = await withBrowserTimeout(input.driver.inspect(controller.signal), timeoutMs, controller);
        pages.push({
          url: navigation.url,
          title: navigation.title?.slice(0, 240),
          text: inspection.text?.slice(0, 2_000),
          links: (inspection.links ?? []).filter((link) => isAllowedBrowserUrl(link, allowedOrigins)).slice(0, 24),
          forms: (inspection.forms ?? []).slice(0, 24),
        });
      }
      for (const action of (input.actions ?? []).slice(0, 30)) {
        if (action.type !== "click" && action.type !== "fill" && action.type !== "press") throw new RufloBrowserPolicyError("invalid_url");
        if (action.selector && action.selector.length > 240) throw new RufloBrowserPolicyError("limit");
        await withBrowserTimeout(input.driver.act({ ...action, value: action.value?.slice(0, 500) }, controller.signal), timeoutMs, controller);
      }
      return {
        role: "browser",
        status: "completed",
        summary: `Completed bounded browser checks across ${pages.length} allowed page(s) and ${(input.actions ?? []).length} action(s).`,
        readFiles: [],
        changedFiles: [],
        references: urls,
        analysis: { pages, actions: (input.actions ?? []).length },
      };
    } catch (error) {
      return {
        role: "browser",
        status: "failed",
        summary: "The bounded browser check failed.",
        readFiles: [],
        changedFiles: [],
        references: urls,
        error: error instanceof Error ? error.message.slice(0, 500) : "Browser check failed.",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type RufloSpecializedDagInput = {
  sessionId: string;
  task: string;
  selectedFiles: string[];
  roles?: RufloSpecializedAgentRole[];
  signal?: AbortSignal;
  inspect: RufloSpecializedInspectRequest["task"] extends never
    ? never
    : (request: RufloSpecializedInspectRequest) => Promise<RufloSpecializedInspection>;
  createProposal?: (request: RufloProposalRequest) => Promise<ChangeProposal>;
  git?: RufloGitIntelligenceInput["read"];
  browser?: Omit<RufloBrowserInput, "task">;
  limits?: Partial<RufloSwarmLimits>;
  onTask?: (task: RufloSwarmTask) => void;
  onAgent?: (execution: RufloAgentExecution<RufloSpecializedAgentResult>) => void;
  remember?: (input: { kind: RufloMemoryKind; fact: string; sourceTaskId: string; outcome: "success" | "failure" }) => Promise<void>;
};

export type RufloSpecializedDagResult = RufloSwarmResult & {
  agentExecutions: RufloAgentExecution<RufloSpecializedAgentResult>[];
};

export async function runRufloSpecializedDag(input: RufloSpecializedDagInput): Promise<RufloSpecializedDagResult> {
  const roles = uniqueRoles(input.roles?.length ? input.roles : selectRufloSpecializedAgents(input.task));
  if (!roles.length) {
    return {
      status: "completed",
      tasks: [],
      completedTaskIds: [],
      failedTaskIds: [],
      blockedTaskIds: [],
      cancelledTaskIds: [],
      conflicts: [],
      toolCalls: 0,
      message: "No specialized Ruflo agent was required for this task.",
      agentExecutions: [],
    };
  }

  const createdAt = new Date().toISOString();
  const tasks = roles.map((role, index): RufloSwarmTask => ({
    taskId: `specialized-${role}-${randomUUID().slice(0, 8)}`,
    sessionId: input.sessionId,
    role,
    description: `${role} analysis for ${input.task}`.slice(0, 500),
    dependencies: [],
    priority: roles.length - index,
    status: "pending",
    attempts: 0,
    timeout: 45_000,
    permissions: role === "test_generator" || role === "documentation" ? ["read", "proposal"] : ["read"],
    expectedFiles: input.selectedFiles.slice(0, 24),
    readIntent: input.selectedFiles.slice(0, 24),
    writeIntent: [],
    createdAt,
  }));
  const operations = new Map<string, RufloTaskOperation>();
  const executions: RufloAgentExecution<RufloSpecializedAgentResult>[] = [];
  for (const task of tasks) {
    operations.set(task.taskId, async (current, context) => {
      currentResultRequiresSignal(current);
      context.consumeToolCall();
      if (input.signal?.aborted) throw new Error("The specialized job was cancelled.");
      const result = await runSpecializedRole(task.role as RufloSpecializedAgentRole, input);
      const execution = createSpecializedExecution(task.role as RufloSpecializedAgentRole, task.description, result, current.attempts + 1);
      executions.push(execution);
      input.onAgent?.(execution);
      if (input.remember) {
        const kind: RufloMemoryKind = result.status === "completed" ? "successful_solution" : "warning";
        const fact = sanitizeMemoryFact(`${roleLabel(task.role as RufloSpecializedAgentRole)}: ${result.summary}`);
        if (fact) await input.remember({
          kind,
          fact,
          sourceTaskId: current.taskId,
          outcome: result.status === "completed" ? "success" : "failure",
        });
      }
      return {
        ...result,
        readFiles: result.readFiles.slice(0, 24),
        changedFiles: [],
        proposedFiles: result.changedFiles.slice(0, 24),
      };
    });
  }
  const scheduler = new RufloDynamicDagScheduler({
    sessionId: input.sessionId,
    tasks,
    operations,
    limits: input.limits,
    onTask: input.onTask,
  });
  const result = await scheduler.run();
  return { ...result, agentExecutions: executions.slice(-64) };
}

export function selectRufloSpecializedAgents(task: string): RufloSpecializedAgentRole[] {
  const value = task.toLowerCase();
  const roles: RufloSpecializedAgentRole[] = [];
  if (/\b(test|tests|testing|coverage|regression|spec)\b/.test(value)) roles.push("test_generator");
  if (/\b(doc|docs|documentation|readme|architecture doc|api doc)\b/.test(value)) roles.push("documentation");
  if (/\b(git|branch|commit history|diff|authorship|changed files|repository status)\b/.test(value)) roles.push("git_intelligence");
  if (/\b(browser|e2e|end.to.end|rendered page|ui check|playwright|cypress)\b/.test(value)) roles.push("browser");
  return roles;
}

export function assertAllowedBrowserUrl(value: string, allowedOrigins: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RufloBrowserPolicyError("invalid_url");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new RufloBrowserPolicyError("invalid_url");
  }
  const origin = parsed.origin.toLowerCase();
  const allowedHosts = allowedOrigins.map((allowed) => {
    try { return new URL(allowed).hostname.toLowerCase(); } catch { return ""; }
  }).filter(Boolean);
  if (!allowedOrigins.some((allowed) => origin === allowed) && !allowedHosts.some((host) => parsed.hostname.toLowerCase() === host || parsed.hostname.toLowerCase().endsWith(`.${host}`))) {
    throw new RufloBrowserPolicyError("domain_not_allowed");
  }
  return parsed;
}

function isAllowedBrowserUrl(value: string, allowedOrigins: readonly string[]): boolean {
  try {
    assertAllowedBrowserUrl(value, allowedOrigins);
    return true;
  } catch {
    return false;
  }
}

function normalizeOrigin(value: string): string {
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return parsed.origin.toLowerCase();
  } catch {
    return "";
  }
}

async function withBrowserTimeout<T>(operation: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RufloBrowserPolicyError("limit"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function identifyTestGaps(sourceFiles: RufloSpecializedInspectionFile[], testFiles: RufloSpecializedInspectionFile[]): string[] {
  const tests = testFiles.map((file) => file.content ?? "").join("\n").toLowerCase();
  return sourceFiles
    .filter((source) => !tests.includes(source.path.toLowerCase().replace(/\.[^.]+$/, "")))
    .map((source) => `No inspected test reference for ${source.path}`)
    .slice(0, 16);
}

function identifyDocumentationGaps(
  sourceFiles: RufloSpecializedInspectionFile[],
  documentationFiles: RufloSpecializedInspectionFile[],
  apiBehavior?: string,
): string[] {
  const docs = documentationFiles.map((file) => file.content ?? "").join("\n").toLowerCase();
  const gaps = sourceFiles
    .filter((source) => /api|route|endpoint|public|export/.test(source.path.toLowerCase()) && !docs.includes(source.path.toLowerCase()))
    .map((source) => `Document externally relevant behavior from ${source.path}`);
  if (apiBehavior?.trim() && !docs.includes("api")) gaps.push("Document the observed API behavior without adding unsupported details.");
  return gaps.slice(0, 16);
}

function boundedInspectionContext(inspection: RufloSpecializedInspection): string {
  return [
    inspection.projectStructure?.slice(0, 4_000) ?? "",
    inspection.apiBehavior?.slice(0, 6_000) ?? "",
    ...inspection.files.slice(0, 24).map((file) => `### ${file.path}\n${file.content?.slice(0, 8_000) ?? "(content not provided)"}`),
  ].filter(Boolean).join("\n\n").slice(0, 48_000);
}

function boundedReferences(inspection: RufloSpecializedInspection): string[] {
  return uniqueStrings([...(inspection.references ?? []), ...inspection.files.map((file) => file.path)]).slice(0, 32);
}

function sanitizeGitSnapshot(snapshot: RufloGitSnapshot): RufloGitSnapshot {
  return {
    status: {
      branch: snapshot.status.branch?.slice(0, 240),
      clean: snapshot.status.clean,
      stagedFiles: uniquePaths(snapshot.status.stagedFiles ?? []).slice(0, 32),
    },
    branches: uniqueStrings(snapshot.branches).slice(0, 32),
    commits: snapshot.commits.slice(0, 24).map((commit) => ({
      sha: commit.sha.replace(/[^a-f0-9]/gi, "").slice(0, 64),
      message: sanitizeUntrusted(commit.message, 500),
      author: sanitizeUntrusted(commit.author ?? "", 160),
      date: sanitizeUntrusted(commit.date ?? "", 64),
    })),
    diffs: snapshot.diffs.slice(0, 32).map((diff) => ({
      path: safePath(diff.path),
      status: sanitizeUntrusted(diff.status, 40),
      additions: boundedNumber(diff.additions),
      deletions: boundedNumber(diff.deletions),
    })),
    changedFiles: uniquePaths(snapshot.changedFiles).slice(0, 32),
    references: uniqueStrings(snapshot.references ?? []).slice(0, 32),
  };
}

function createSpecializedExecution(
  role: RufloSpecializedAgentRole,
  summary: string,
  output: RufloSpecializedAgentResult,
  attempt: number,
): RufloAgentExecution<RufloSpecializedAgentResult> {
  const now = new Date().toISOString();
  return {
    executionId: randomUUID(),
    role,
    status: output.status === "failed" ? "failed" : "completed",
    iteration: attempt,
    attempts: attempt,
    input: { sourceExecutionIds: [], summary: summary.slice(0, 1_000) },
    output,
    startedAt: now,
    completedAt: new Date().toISOString(),
  };
}

async function runSpecializedRole(role: RufloSpecializedAgentRole, input: RufloSpecializedDagInput): Promise<RufloSpecializedAgentResult> {
  if (role === "test_generator") {
    if (!input.createProposal) throw new Error("The Test Generator requires the proposal boundary.");
    return new RufloTestGeneratorAgent().run({
      task: input.task,
      selectedFiles: input.selectedFiles,
      inspect: input.inspect,
      createProposal: input.createProposal,
    });
  }
  if (role === "documentation") {
    if (!input.createProposal) throw new Error("The Documentation Agent requires the proposal boundary.");
    return new RufloDocumentationAgent().run({
      task: input.task,
      selectedFiles: input.selectedFiles,
      inspect: input.inspect,
      createProposal: input.createProposal,
    });
  }
  if (role === "git_intelligence") {
    if (!input.git) throw new Error("The Git Intelligence Agent requires a read-only Git adapter.");
    return new RufloGitIntelligenceAgent().run({ task: input.task, read: input.git });
  }
  return new RufloBrowserAgent().run({ task: input.task, ...(input.browser ?? { urls: [], allowedOrigins: [] }) });
}

function currentResultRequiresSignal(task: RufloSwarmTask): void {
  if (task.status === "cancelled") throw new Error("The specialized task was cancelled.");
}

function specializedFailure(summary: string, readFiles: string[]): RufloSpecializedAgentResult {
  return { role: "test_generator", status: "failed", summary, readFiles, changedFiles: [], references: [] };
}

function roleLabel(role: RufloSpecializedAgentRole): string {
  return role === "test_generator" ? "Test Generator" : role === "git_intelligence" ? "Git Intelligence" : role === "documentation" ? "Documentation" : "Browser";
}

function uniqueRoles(values: readonly RufloSpecializedAgentRole[]): RufloSpecializedAgentRole[] {
  return [...new Set(values)].slice(0, 4);
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map(safePath).filter(Boolean))].slice(0, 64);
}

function safePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").trim();
  return normalized && !normalized.startsWith("/") && !normalized.includes("\0") && !normalized.split("/").includes("..")
    ? normalized.slice(0, 500)
    : "";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => sanitizeUntrusted(value, 500)).filter(Boolean))];
}

function sanitizeUntrusted(value: string, max: number): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, max);
}

function boundedNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, Math.floor(value))) : 0;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value as number))) : fallback;
}