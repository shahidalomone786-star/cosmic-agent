# Ruflo Architecture Audit

**Audit mode:** Phase 0, static/read-only inspection
**Audit scope:** Current repository working tree, with particular attention to
`artifacts/api-server/src/`, `artifacts/cosmic-agent/src/`, `lib/db/`,
package manifests, database configuration, and Ruflo-related tests.
**Evidence policy:** A filename or comment was not treated as proof of a
capability. Classifications below are based on imports, exported symbols,
route behavior, data flow, and test presence. No feature was implemented by
this audit. No test, typecheck, build, lint, migration, or browser command was
run as part of this audit, so no new execution result is claimed.

## 1. Executive Summary

Cosmic Agent contains a real, bounded Ruflo implementation, but it is not yet
a swarm-orchestration platform. The current Ruflo path is a server-controlled
inspection and proposal pipeline:

1. An authenticated user starts a Ruflo session.
2. `runRufloSession` uses a bounded planner/action/observation loop.
3. Ruflo may inspect a connected GitHub repository or a local workspace through
   read-only tools.
4. Preparation agents create a `ChangeProposal`.
5. Human approval is required before local application.
6. A sequential reviewer/validator workflow runs after approval.
7. Validation failure rolls back and produces a bounded fixer proposal that
   requires another approval.
8. Separate commit and push approvals protect GitHub writes.

The strongest implemented boundary is the approval-gated proposal/apply/
validate/commit/push lifecycle. The main gaps are durable orchestration,
cancellation, DAG/dependency scheduling, parallel workers, file locking,
semantic memory, broad provider support, cost accounting, durable event
streaming, and browser/E2E coverage.

The most important safety risks identified by inspection are:

- local workspace operations use `path.join` without a realpath check for
  symlinked ancestors;
- process-local session, proposal, approval, and lock maps do not survive
  restart or coordinate multiple instances;
- repository content is supplied to models without a dedicated prompt-injection
  or provenance enforcement layer;
- local workspace reads are not secret-redacted in the same way as GitHub reads;
- generic authenticated review/report endpoints are schema-validated but not
  visibly bound to a session or report owner;
- global CORS and cookie-authenticated state-changing routes have no visible
  CSRF/origin policy;
- several Ruflo session/execute APIs are used directly by the frontend but are
  absent from the OpenAPI/generated-client boundary.

## 2. Repository/Ruflo Structure

### Product artifacts

- `artifacts/api-server/` — Express API, AI runtime, repository access,
  proposal/patch execution, validation, GitHub writes, authentication routes,
  Ruflo routes, and Node test entry points.
- `artifacts/cosmic-agent/` — React/Vite frontend with Chat, Normal Agent, and
  Ruflo Mode, repository explorer, proposal review, preview, settings, and
  resource panels.
- `lib/api-spec/openapi.yaml` — API contract source.
- `lib/api-zod/` — generated server-side request/response schemas.
- `lib/api-client-react/` — generated frontend API client and schemas.
- `lib/db/` — Drizzle/PostgreSQL schema and database connection.
- `.replit` — run/deployment and workspace configuration.
- root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` — workspace
  scripts and package management.

### Ruflo-specific implementation

- `artifacts/api-server/src/ruflo/ruflo-runtime.ts`
  - `runRufloSession`
  - `createRufloToolExecutor`
  - `RufloRunInput`, `RufloSession`, `RufloLimits`, `RufloEvent`
- `artifacts/api-server/src/ruflo/ruflo-planner.ts`
  - `ModelRufloPlanner`
  - `RufloPlan`, `RufloDecision`, `RufloAction`
- `artifacts/api-server/src/ruflo/ruflo-agents.ts`
  - `RufloSequentialCoordinator`
  - `RufloPlannerAgent`, `RufloCoderAgent`, `RufloReviewerAgent`,
    `RufloValidatorAgent`, `RufloFixerAgent`
- `artifacts/api-server/src/ruflo/ruflo-proposal.ts`
  - `createRufloProposal`
  - `reviewRufloProposal`
- `artifacts/api-server/src/ruflo/ruflo-workflow.ts`
  - `runRufloPostApproval`
  - `MAX_RUFLO_RECOVERY_ATTEMPTS`
- `artifacts/api-server/src/ruflo/memory-policy.ts`
  - bounded memory limits and `sanitizeMemoryFact`
- `artifacts/api-server/src/ruflo/memory-store.ts`
  - `RufloMemoryStore`, `projectMemoryKey`
- `artifacts/api-server/src/ruflo/database-session-store.ts`
  - `DatabaseRufloSessionStore`
- `artifacts/api-server/src/ruflo/session-store.ts` and `types.ts`
  - persistence interfaces and public database-facing Ruflo types
- `artifacts/api-server/src/routes/ruflo.ts`
  - Ruflo session, execution, Git review, commit, push, polling, public-state,
    activity, and memory lifecycle routes

### Ruflo tests located

- `artifacts/api-server/test/ruflo-runtime.test.mjs`
- `artifacts/api-server/test/ruflo-agents.test.mjs`
- `artifacts/api-server/test/ruflo-workflow.test.mjs`
- `artifacts/api-server/test/ruflo-memory.test.mjs`
- `artifacts/api-server/test/ruflo-proposal-apply.test.mjs`
- `artifacts/api-server/test/ruflo-proposal-apply-entry.mjs`
- `artifacts/api-server/test/ruflo-git-boundary.test.mjs`

## 3. Existing Components

### Runtime and planner

`runRufloSession` in `ruflo-runtime.ts` owns the Ruflo run and stops at the
proposal-ready boundary. It accepts a provider, optional fallback providers,
repository/workspace context, selected files, memory context, limits, and an
update callback. The runtime itself, rather than the model, decides whether a
requested action is allowed.

`ModelRufloPlanner` in `ruflo-planner.ts` produces a bounded plan and decisions.
The planner supports a small action set and its prompts explicitly exclude
writes, swarm behavior, memory mutation, and parallel work.

### Ruflo agents

`RufloSequentialCoordinator` records structured role executions, retries each
role within a limit, and enforces maximum role and iteration counts. The roles
are fixed: planner, coder, reviewer, validator, and fixer. Preparation runs
planner then coder. Post-approval workflow runs reviewer then validator, with a
fixer only after rollback and validation failure.

These are structured server-side role stages, not independent autonomous
workers with separate runtimes, processes, queues, or durable leases.

### Proposal and workflow

`createRufloProposal` creates a repository or local-workspace proposal and
registers it with the shared patch executor. `reviewRufloProposal` checks that
operations are non-empty, text-only, path-safe, and within the bounded
inspection scope.

`runRufloPostApproval` deliberately receives an already approved/applied
proposal. It performs reviewer and validator stages, rolls back on failure, and
returns a new fixer proposal in `waiting_approval` rather than applying a fix
automatically.

### Persistence

`DatabaseRufloSessionStore` persists coarse session status, goal, tasks, and
activities. The live runtime session, proposal, agent executions, locks,
approval objects, and most workflow state remain in process memory.

`rufloMemoryTable` is a separate project-scoped persistent fact store. It is
bounded and sanitized, but it is a recency list rather than a semantic memory
system.

## 4. Shared Infrastructure

Ruflo reuses the existing application infrastructure rather than introducing a
separate provider, auth, workspace, or Git subsystem.

| Shared area | Evidence | Audit result |
|---|---|---|
| Authentication | `src/middlewares/auth-middleware.ts`, `requireAuthenticatedUser`, `req.authUser` | Partial: route authentication and ownership checks exist, but state is process-local and cookie/CSRF policy is incomplete. |
| Providers | `src/ai/ai-provider.ts`, `ProviderManager`, `GroqProvider`, `GeminiProvider` | Partial: two real providers, bounded key rotation, no broad provider abstraction coverage. |
| Repository reads | `src/repository/github-provider.ts`, `retrieveRepositoryContext`, `readRepositoryFile`, `searchRepository` | Implemented for bounded read access, with redaction and context limits; repository binding and local-vs-remote trust boundaries need further hardening. |
| Local workspace | `src/workspace/local-workspace.ts` | Partial/unsafe: traversal and protected names are filtered, but symlink realpath confinement is absent. |
| Proposal model | `src/ai/change-proposal.ts`, `ChangeProposal` | Implemented and shared by Normal Agent and Ruflo. |
| Approval | `src/ai/approval-gate.ts`, `approveProposal`, `assertApproval` | Implemented but process-local. |
| Patch execution | `src/repository/patch-executor.ts`, `executeProposal`, `undoProposal`, `commitProposal`, `pushProposal` | Implemented for bounded operations; local and GitHub operations have different operation support. |
| Validation | `src/workspace/local-validation.ts`, `src/ai/validation-runtime.ts`, `src/ai/validator-runtime.ts` | Partial: deterministic checks exist, but no sandbox/resource isolation. |
| GitHub writes | `src/repository/github-write-provider.ts`, `GitHubApiWriteProvider` | Implemented with permission checks, compare-and-check, non-force push, and Ruflo route verification. |
| Streaming/events | `src/routes/ai.ts`, `AgentEvent`, Ruflo `RufloEvent`, frontend polling | Partial: chat SSE and persisted coarse activity exist; Ruflo progress is polling-based and mostly process-local. |

## 5. Normal Agent Isolation

### Dependency trace

**Normal Agent**

`artifacts/cosmic-agent/src/App.tsx` selects `agent` mode or automatically
classifies coding-like Chat requests. It calls
`/api/ai/agent/sessions` or local workspace proposal routes. The server path
enters `runAgentSession` in `artifacts/api-server/src/ai/agent-runtime.ts`,
which uses manager classification/planning, Normal Agent worker tooling,
reviewer/validator runtimes, and the shared proposal/approval infrastructure.

**Ruflo**

The frontend selects `ruflo` mode and calls
`/api/ruflo/sessions`. The server enters `runRufloSession`,
`runRufloPreparationAgents`, and `runRufloPostApproval` through
`artifacts/api-server/src/routes/ruflo.ts`. Ruflo has separate runtime session
types, route paths, phases, activities, limits, and agent role types.

**Shared**

Both paths use some of the same:

- `AiProvider` and `ProviderManager`;
- GitHub repository read/context services;
- local workspace services;
- `ChangeProposal`;
- `approval-gate.ts`;
- `patch-executor.ts`;
- local and remote validation;
- GitHub write policy/provider;
- authentication middleware and database connection.

### Isolation result

**Classification: PARTIAL, with medium regression risk.**

No direct Ruflo call was found that intentionally changes Normal Agent state or
routes. The runtime and route namespaces are separate. However, the shared
process-local maps and services mean a change to approval, patch, validation,
provider, workspace, or GitHub policy can affect both modes.

Observed coupling risks:

- both modes register proposals into the shared patch-executor session map;
- both modes consume the shared process-local approval map;
- both modes share provider key/cooldown state and provider metrics;
- both modes use overlapping local workspace and GitHub path policies;
- Normal Agent has richer manager/worker/dependency concepts, while Ruflo
  intentionally does not use those components;
- the frontend contains separate ad-hoc Ruflo types and direct fetches beside
  generated Normal Agent client calls, increasing contract-drift risk.

For this Phase 0 audit, **Normal Agent modified: NO**.

## 6. Core Runtime Audit

| Capability | Classification | Evidence and boundary |
|---|---|---|
| Ruflo runtime | IMPLEMENTED | `runRufloSession` in `ruflo-runtime.ts` creates a bounded session, planner decision loop, read-only tool calls, observations, events, and proposal-ready/failed/limit-reached terminal states. |
| ReAct loop | PARTIAL | The loop is decision → server-validated action → tool execution → observation (`runRufloSession`). It is a constrained JSON action loop, not a full free-form ReAct reasoning/tool protocol. |
| Planner | IMPLEMENTED | `ModelRufloPlanner` creates a maximum-six-step ordered plan and bounded decisions. |
| Agents | PARTIAL | `RufloPlannerAgent`, `RufloCoderAgent`, `RufloReviewerAgent`, `RufloValidatorAgent`, and `RufloFixerAgent` provide structured stages, but not independent autonomous runtimes. |
| Task decomposition | PARTIAL | The planner and `RufloPlannerAgent` can split a request into bounded ordered steps, but the plan has no dependency graph or scheduler. |
| Limits | IMPLEMENTED | `DEFAULT_RUFLO_LIMITS` bounds iterations, tool calls, runtime, retries, agent count, and total agent iterations. Limits are normalized/clamped by the runtime. |
| Retries | IMPLEMENTED | Runtime/provider/tool and coordinator retry paths exist, with bounded retry counts and failure events. |
| Timeouts | PARTIAL | `withRuntimeBudget`/bounded operation races enforce deadlines, but a timeout rejects the waiting promise without reliably aborting the underlying provider/tool operation. |
| Cancellation | MISSING | Ruflo routes expose no cancel/abort operation. The `cancelled` database status exists, but no runtime cancellation flow or request-level abort propagation was found. |

The Ruflo runtime intentionally does not write files during inspection. Proposal
creation is a later agent stage and local/GitHub writes remain behind approval
and patch-executor controls.

## 7. Swarm Audit

Ruflo is explicitly sequential. `RufloSequentialCoordinator` in
`ruflo-agents.ts` runs one role operation at a time, and the planner prompt
forbids swarm and parallel work.

| Capability | Classification | Evidence |
|---|---|---|
| Sequential execution | IMPLEMENTED | `RufloSequentialCoordinator.run`; preparation and post-approval stages are ordered. |
| DAG/task graph | MISSING | Ruflo `RufloPlan` is an ordered step list. No Ruflo DAG node/edge/scheduler implementation was found. |
| Dependencies | MISSING | Ruflo has no dependency resolver or dependency-gated task executor. Normal Agent has dependency-shaped state, but that is not Ruflo. |
| Parallel execution | MISSING | No `Promise.all` worker scheduling or parallel Ruflo worker execution was found. |
| Concurrency limits | PARTIAL | Role and iteration limits and a per-session in-memory execution lock exist. There is no worker concurrency scheduler or cross-instance lease. |
| Agent specialization | PARTIAL | Fixed role labels exist, but specialization is static and stage-based rather than dynamically assigned worker capabilities. |
| Failure isolation | PARTIAL | A role failure produces structured failure state and can stop the pipeline safely. There are no isolated worker processes, durable task leases, or per-task resource boundaries. |
| Result aggregation | PARTIAL | Agent execution snapshots and bounded summaries are collected. There is no multi-worker merge, consensus, or conflict-resolution aggregation. |
| File locking | MISSING | `rufloExecutionLocks` protects approval execution per session only; no file lock or repository lock exists. |
| Conflict detection | PARTIAL | Proposal/file hashes, stale-file checks, and remote branch comparisons exist. Multi-agent file conflict detection is absent. |

The Normal Agent runtime contains manager/worker concepts and dependency-shaped
state in `ai/agent-runtime.ts`, but those capabilities must not be counted as
Ruflo swarm support.

## 8. Safety/Approval Audit

| Capability | Classification | Evidence and finding |
|---|---|---|
| Path traversal protection | PARTIAL/UNSAFE | `safeWorkspaceRelative` and patch `safeRelative` reject absolute paths, `..`, protected names, and selected extensions. Symlinked ancestors are not realpath-checked. |
| Workspace boundaries | PARTIAL/UNSAFE | `workspacePath` sanitizes IDs and operations use `path.join`; no canonical realpath containment check protects read/write/remove/rename. Patch execution can default to the discovered monorepo execution root. |
| Binary restrictions | PARTIAL | Extension and NUL checks block common binary edits. Unknown binary content can still be treated as UTF-8 text because classification is largely extension/content based. |
| Secret protection | PARTIAL/UNSAFE | Protected filenames, GitHub response redaction, evidence redaction, and memory regex filtering exist. Local workspace reads return raw text and regex filtering is not a complete secret scanner. |
| Tool permissions | IMPLEMENTED | `AgentToolDefinition`, role-specific allowlists, `AgentToolError`, and Ruflo's three-tool union keep model-requested tools bounded server-side. |
| Prompt-injection protection | MISSING/UNSAFE | No independent prompt-injection detector, provenance label, delimiter policy, or model-independent instruction hierarchy for repository content was found. |
| Session authorization | PARTIAL | Auth middleware and per-user session/proposal checks exist. Runtime/proposal/approval state is process-local and restart/multi-instance behavior is not durable. |
| Approval enforcement | IMPLEMENTED | `approveProposal`/`assertApproval` bind approval to action, proposal version, repository identity/hash, original file hashes, user, and optional task. |
| Commit approval | IMPLEMENTED | `commitProposal` requires separate `"commit"` approval after validated application and staging. |
| Push approval | IMPLEMENTED | `pushProposal` requires separate `"push"` approval, branch comparison, and safe push policy. |
| Runtime/tool/token limits | PARTIAL | Runtime/tool/agent limits and approximate provider budget bookkeeping exist. There is no actual tokenizer, spend calculation, or durable global budget. |

### Approval lifecycle

The primary guard is `approval-gate.ts`. The Ruflo execute route additionally
requires the authenticated owner, current session, current proposal ID,
`waiting_approval` phase, and an in-memory per-session lock. The shared patch
executor independently asserts the server-held approval before applying,
staging, committing, or pushing.

This is a strong logical boundary while the process is alive. Its main
operational limitation is that `approvals`, proposal sessions, runtime entries,
and locks are Maps/Sets in server memory rather than durable, transactionally
owned records.

## 9. Patch/Recovery Audit

| Capability | Classification | Evidence and finding |
|---|---|---|
| `ChangeProposal` | IMPLEMENTED | `ai/change-proposal.ts` defines operations, original/proposed code, diff/line statistics, risk, plan, and validation plan. |
| Add operation | IMPLEMENTED | Local patch application supports create and `directory_create`; GitHub commit path handles file create/edit content. |
| Modify/edit operation | IMPLEMENTED | Stale original-content checks and atomic replacement are implemented. |
| Delete operation | PARTIAL | Local apply/rollback supports delete, but `verifyValidatedFiles` rejects delete for GitHub commit. |
| Rename operation | PARTIAL | Local apply/rollback supports rename, but GitHub commit rejects rename. |
| Diff tracking | PARTIAL | `changeStats`, proposal file metadata, GitHub compare/diff APIs, and frontend line counters exist. There is no durable Ruflo diff history separate from the proposal/session record. |
| Rollback | IMPLEMENTED/PARTIAL | Snapshots and `restoreSnapshots` support rollback and undo. A rollback failure is surfaced after a potentially partial write, and no filesystem transaction/sandbox is used. |
| Validation | PARTIAL | Local checks include file references, syntax, TypeScript, and Vite commands. Remote checks use validator/evidence traces. Commands run in the workspace/toolchain context without a separate sandbox. |
| Fixer | PARTIAL | `RufloFixerAgent` creates a proposal from a validation diagnosis. It does not automatically apply or independently rerun the full plan. |
| Retry/recovery | IMPLEMENTED | `MAX_RUFLO_RECOVERY_ATTEMPTS` is three; validation failure rolls back before creating a fix proposal. |
| Re-approval | IMPLEMENTED | Recovery returns `waiting_approval`; the new proposal must be explicitly approved before another execution. |

The patch executor supports atomic temporary-file replacement for text files,
stale original-content checks, validation-state gating, and exact undo
snapshots. Its GitHub commit model intentionally limits committed operations to
file create/edit even though the proposal type can represent more operations.

## 10. Database/Memory Audit

### Database

`lib/db/src/schema/ruflo.ts` defines:

- `rufloSessionsTable` with user ownership, goal, status, and timestamps;
- `rufloTasksTable` with session relation, title/description, status, and
  position;
- `rufloActivitiesTable` with session/task relation, kind, message, and time;
- `rufloMemoryTable` with user, project key, memory kind, fact, source session,
  and timestamps.

The schema is exported from `lib/db/src/schema/index.ts`. `lib/db/src/index.ts`
and `lib/db/drizzle.config.ts` require `DATABASE_URL`. No Ruflo migration or
SQL deployment artifact was found during repository inspection; deployed
database availability is therefore **UNKNOWN from this tree**.

### Memory capability matrix

| Capability | Classification | Evidence |
|---|---|---|
| Persistent memory | IMPLEMENTED | `RufloMemoryStore.remember/listMemory` writes to `ruflo_memory`. |
| Project/session scope | PARTIAL | Facts are scoped by authenticated user and `projectMemoryKey` (GitHub owner/name/branch or local project). Source session ID is retained, but retrieval is project-scoped rather than session-scoped. |
| Keyword search | MISSING | No memory query/search endpoint or fact matching was found; retrieval is recency ordered. |
| Semantic/vector search | MISSING | No vector column, vector index, similarity query, or semantic retrieval implementation was found. |
| Embeddings | MISSING | No embedding provider or embedding generation path was found. |
| Deduplication | IMPLEMENTED | `remember` checks user/project/kind/fact and updates existing facts. |
| Relevance/confidence | PARTIAL | Newest facts are selected and planner context labels memory as lower priority. No learned relevance score or confidence field exists. |
| Success/failure learning | PARTIAL | Routes derive bounded technology, architecture, success, and validation-problem facts. This is heuristic fact extraction, not outcome-weighted learning. |
| Secret filtering | PARTIAL/UNSAFE | `sanitizeMemoryFact` applies bounded regex redaction and tests cover known patterns. It is not a complete secret scanner, and it does not protect all raw local source reads. |

Memory limits are explicit: 1,000 characters per fact, 12 retrieved facts,
6,000 context characters, and 48 persisted facts per user/project. Historical
memory is explicitly lower priority than current repository evidence.

## 11. Provider/Tool Audit

### Providers

| Provider/capability | Classification | Evidence |
|---|---|---|
| Gemini | IMPLEMENTED | `GeminiProvider`, `GeminiKeyManager`, SSE parsing, health status, and key rotation. |
| Groq | IMPLEMENTED | `GroqProvider`, `GroqKeyManager`, OpenAI-compatible Groq endpoint, SSE parsing, health status, and key rotation. |
| OpenAI | MISSING | No concrete OpenAI provider was found; OpenAI-named model IDs are routed through configured providers, not proof of an OpenAI integration. |
| Anthropic | MISSING | No concrete provider or API client found. |
| Cohere | MISSING | No concrete provider or API client found. |
| Ollama/local | MISSING | No local model transport or Ollama provider found. |
| Fallback | PARTIAL | Key-level failover exists within Gemini/Groq. Ruflo accepts optional fallback providers, but normal routes do not show a general cross-provider policy. |
| Model routing | PARTIAL | `model-registry.ts` allowlists models and maps them to Groq or Gemini through `ProviderManager`. Dynamic role/cost/capability routing is absent. |
| Token/cost tracking | PARTIAL | `provider-metrics.ts` records approximate input/output characters, retries, duration, and counters. It does not calculate tokens, price, spend, or user/session budget. |

The provider interface in `ai-provider.ts` supports chat, stream, model listing,
and health checks. The concrete `AiModel.provider` type is limited to `"groq"`
and `"gemini"`.

### Ruflo tools and registry

| Tool capability | Classification | Evidence |
|---|---|---|
| Existing Ruflo tools | IMPLEMENTED | `createRufloToolExecutor` exposes `inspect_repository`, `search_repository`, and `read_file` only. |
| Tool registry | PARTIAL | Ruflo has a typed union and executor; the broader Normal Agent has `getAgentToolDefinitions`. No extensible Ruflo registry/plugin lifecycle was found. |
| MCP | MISSING | No MCP client/server/transport/tool projection was found in the inspected application source. |
| Permissions | IMPLEMENTED | Server-side runtime authorization controls action names and keeps model output from directly invoking writes. |
| Risk levels | PARTIAL | Normal Agent tool definitions use `read`, `proposal`, and `approval_required`; Ruflo tools are effectively read-only but do not expose a complete per-tool risk registry. |
| Timeouts | PARTIAL | Tool definitions carry timeout values and operations use promise races; underlying operations are not reliably aborted. |
| Audit logging | PARTIAL | Agent traces, Ruflo events, and coarse database activities exist. There is no durable, comprehensive security audit log for every tool input/output and authorization decision. |

## 12. Git/GitHub Audit

| Capability | Classification | Evidence and finding |
|---|---|---|
| Repository/branch handling | IMPLEMENTED/PARTIAL | `RepositoryRef`, GitHub URL/branch checks, repository permission lookup, and branch validation exist. Repository identity is still supplied by request data and must remain bound to the authenticated workflow. |
| Diff | IMPLEMENTED | `GitHubApiWriteProvider.getDiff` uses GitHub compare; proposal and frontend also expose bounded diff summaries. |
| Commit | IMPLEMENTED | `createCommit` builds blobs/tree/commit against an expected remote head. |
| Push | IMPLEMENTED | `pushBranch` compares the expected head, sets `force: false`, and updates the requested branch. |
| Authentication | IMPLEMENTED/PARTIAL | Per-user GitHub credential lookup and connected-status checks exist; credentials are encrypted server-side. |
| Secret protection | PARTIAL | GitHub paths and responses are filtered/redacted, but broad logger guarantees and complete local-source redaction are not established. |
| Commit approval | IMPLEMENTED | Separate `"commit"` approval is asserted by `commitProposal`. |
| Push approval | IMPLEMENTED | Separate `"push"` approval is asserted by `pushProposal`. |
| Force-push protection | IMPLEMENTED | `assertSafePush` rejects force pushes and branch mismatches; GitHub update body sets `force: false`. |
| Remote SHA verification | IMPLEMENTED for Ruflo route; PARTIAL overall | Ruflo push route reads the branch after pushing and uses `assertRemoteHeadMatches`. The generic Normal Agent push route does not visibly perform the same post-write lookup/verification. |

Important symbols include `GitHubApiWriteProvider`,
`resolveRepositoryWritePermission`, `assertSafeRepositoryPath`,
`assertSafePush`, `classifyGitHubWriteFailure`, and
`assertRemoteHeadMatches`.

The compare-then-update sequence is not a single atomic application-level
transaction. GitHub's ref update can reject a race, but the code relies on that
response rather than an application-side distributed lock.

## 13. Streaming/Test/Browser Audit

### Streaming and events

| Capability | Classification | Evidence |
|---|---|---|
| Polling | IMPLEMENTED | `App.tsx` polls Normal Agent and Ruflo sessions every 700ms; preview status is polled separately. |
| SSE | IMPLEMENTED/PARTIAL | `/api/ai/chat/stream` and provider stream parsers emit token SSE. Ruflo progress is not SSE. |
| WebSocket | MISSING | No WebSocket server/client was found. |
| Event storage | PARTIAL | Runtime events/traces are retained in memory; Ruflo activity summaries are written to the database. Full session event replay is not durable. |
| Reconnect/fallback | PARTIAL | Frontend polling keeps the last visible snapshot on transient errors. There is no cursor, replay token, durable event sequence, or robust reconnect protocol. |

SSE has no explicit heartbeat, replay cursor, or backpressure policy visible in
`routes/ai.ts`. The browser aborts Chat generation through `AbortController`,
but Ruflo has no equivalent cancellation path.

### Testing and browser automation

| Capability | Classification | Evidence |
|---|---|---|
| Unit/integration tests | PARTIAL | API tests are Node/esbuild entry points and cover many pure/runtime boundaries. No broad HTTP integration suite was found. |
| Ruflo tests | IMPLEMENTED | Dedicated runtime, agents, workflow, memory, proposal-apply, and Git-boundary tests exist. |
| Typecheck | IMPLEMENTED as a script | Root, API, frontend, and library manifests expose TypeScript checks. This audit did not execute them. |
| Build | IMPLEMENTED as a script | Root/API/frontend build scripts exist. This audit did not execute them. |
| Lint | MISSING | No lint script or lint configuration was found in the inspected manifests. |
| Playwright/Cypress/E2E | MISSING | No Playwright/Cypress config or frontend browser test files were found. |

The API test script intentionally builds temporary bundles under `test-dist`
before running Node tests. Those bundles are test infrastructure output, not
Ruflo runtime functionality.

## 14. Worker/Frontend Audit

### Automation infrastructure

| Capability | Classification | Evidence |
|---|---|---|
| Workers | PARTIAL | Normal Agent has frontend/backend/reviewer/validator role execution in `worker-runtime.ts` and `agent-runtime.ts`; Ruflo role stages are sequential in-process calls. |
| Scheduler/cron | MISSING | No scheduler or cron implementation was found. |
| Queues | MISSING | No durable queue, Bull/BullMQ, worker-thread pool, or job broker was found. |
| Event-driven jobs | MISSING | Events update in-memory/database activity but do not enqueue durable jobs. |

### Ruflo frontend

`artifacts/cosmic-agent/src/App.tsx` provides a distinct `ComposerMode` with
`ruflo`, `RufloClientSession`, Ruflo activity/status rendering, 700ms polling,
and direct Ruflo session/execute calls. `RufloActivityPanel` renders:

- current agent and current phase;
- affected files;
- proposal, validation, and Git status;
- recent activity;
- plan steps;
- recovery attempts and approval messaging.

`change-proposal-review.tsx` supplies approval-gated code execution and
separate Git commit/push review/action endpoints. The server implementation is
substantive, not only a visual mode label.

| Frontend capability | Classification | Evidence and finding |
|---|---|---|
| Ruflo mode | IMPLEMENTED | `ComposerMode`, mode picker, Ruflo start request, and `RufloActivityPanel`. |
| Session | PARTIAL | Start and polling work through custom endpoints, but server runtime state is process-local and not resumable after restart. |
| Activity | IMPLEMENTED | Server maps events/agent executions to bounded public activities; UI displays recent activity. |
| Agents | PARTIAL | Current role and labels are shown. Detailed `agentExecutions` are returned by the server but are not fully rendered as a worker graph/report. |
| Tasks | PARTIAL | Ordered runtime plan is rendered. Database task tables and Ruflo task routes are not wired into the live session path. |
| Proposal/approval | IMPLEMENTED | Proposal review and explicit code approval are connected to server-held approvals. |
| Validation | IMPLEMENTED/PARTIAL | UI shows pass/fail/not-verified and recovery messages; actual checks are server-side. |
| Git | IMPLEMENTED | Ruflo commit review, commit, push review, and push are wired; operations remain separately approved. |
| Cost | MISSING | No cost or token usage panel is exposed. |
| Memory | PARTIAL | A memory count is returned in `RufloClientSession`, but memory facts/context are not displayed or managed in the panel. |
| Workers | PARTIAL | Role labels/current agent are visible, but there is no worker graph, queue, concurrency, or worker report UI. |
| Streaming | PARTIAL | Ruflo uses polling; general Chat uses SSE. |

Other frontend findings:

- conversations, selected repository, and preview proposal ID are localStorage
  state rather than server-persisted session state;
- `mock-repository-provider.ts` is explicitly a not-implemented frontend
  abstraction and is not proof of backend repository support;
- preview controls poll a running approved runtime and can leave a preview
  running after the panel is closed unless explicitly stopped;
- OpenAPI/generated clients cover Normal Agent and Ruflo Git endpoints, but
  Ruflo session start/get/execute are used by direct fetches and have ad-hoc
  frontend types rather than generated contract coverage;
- the direct Ruflo execute fetch path should be treated as a contract/auth
  drift risk because neighboring helpers explicitly pass credentials.

## 15. Security Findings

This section reports findings only. No security fix was applied in Phase 0.

### High-priority findings

1. **Symlink workspace escape risk — UNSAFE**
   `artifacts/api-server/src/workspace/local-workspace.ts` uses
   `path.join(base, safe)` for `readWorkspaceFile`, `writeWorkspaceFile`,
   `removeWorkspacePath`, `createWorkspaceDirectory`, and
   `renameWorkspacePath`. Listing skips symlink entries, but operations do not
   resolve and verify realpaths for existing or newly-created ancestors. An
   attacker who can place a symlink may be able to redirect an operation
   outside the intended workspace.

2. **Process-local authorization/state — HIGH OPERATIONAL RISK**
   `routes/ruflo.ts`, `approval-gate.ts`, and `patch-executor.ts` use
   in-memory Maps/Sets for runtime sessions, approvals, proposals, and locks.
   Restart loses live state; multiple instances can disagree about ownership,
   approvals, locks, or workflow progress. The database fallback returns a
   skeletal session and can map an active persisted session to a waiting state
   without the original live proposal.

3. **Repository prompt injection — UNSAFE/PARTIAL**
   Repository source, README content, comments, and tool output are included in
   model context by `withRepositoryContext`, repository context services, and
   Ruflo planner inputs. The code instructs the model not to infer facts and
   keeps the server authoritative, but no independent detector, untrusted
   content delimiter/provenance model, or policy layer prevents repository text
   from attempting to override model instructions.

4. **Local secret exposure — UNSAFE/PARTIAL**
   GitHub reads apply `redactSecrets`/`redactGitSensitive` in relevant paths,
   and proposal/memory/evidence paths have pattern filters. However
   `readWorkspaceFile` returns raw local text and ordinary filenames can contain
   embedded credentials. Regex filtering is not proof of complete secret
   protection.

5. **CSRF/origin policy gap — UNSAFE**
   `app.ts` uses global `cors()` and cookie-authenticated state-changing routes
   are visible in the auth/proposal/settings flows. The inspected auth
   middleware and routes do not show CSRF tokens or origin checks. `SameSite`
   and `Secure` cookie attributes reduce exposure but are not a complete
   server-side CSRF policy.

### Additional findings

- **Workspace identity collision risk — PARTIAL:** `workspacePath` removes all
  characters outside `[a-zA-Z0-9_-]` from user/project IDs, which can map
  different identifiers to the same filesystem directory.
- **Validation isolation — PARTIAL:** fixed `pnpm` commands avoid shell strings,
  but they execute in the workspace/toolchain process context without a
  separate sandbox, resource quota, or untrusted-project isolation boundary.
- **Generic report/review binding — PARTIAL:** `/api/ai/agent/reviews` and
  `/api/ai/agent/worker-reports` are schema-validated and authenticated by the
  router namespace, but the inspected handlers do not visibly bind every
  caller-supplied report to a server-owned session/worker execution.
- **Approval durability — PARTIAL:** logical proposal/version/file-hash/action
  binding is strong while memory is available, but approval records are not
  durable and cannot be audited or resumed across process failure.
- **Remote compare TOCTOU — PARTIAL:** compare-before-commit/push and
  fast-forward-only GitHub updates protect common races, but compare and ref
  update are not one application-level transaction.
- **Credential encryption fallback — PARTIAL/UNSAFE:** `github-crypto.ts`
  accepts `GITHUB_CREDENTIAL_ENCRYPTION_KEY` or falls back to
  `SESSION_SECRET`; key rotation/KMS separation is not visible.
- **Error and output exposure — PARTIAL:** public APIs constrain many summaries
  and redact known values, but local validation/tool output and provider/logger
  paths require continued review for accidental source or credential exposure.

### Rule-override assessment

Repository content, README files, comments, and tool output can enter model
context, so prompt-injection risk is real. The server does not grant those
contents authority to directly call write tools: Ruflo tool names are bounded,
proposal creation is separate, and apply/commit/push operations require
server-held approvals. This is a defense-in-depth gap, not evidence that
repository content can directly bypass the approval gate.

## 16. Capability Matrix

The following matrix is the consolidated baseline. `PARTIAL` means a bounded
subset exists but the requested capability is incomplete. `UNSAFE` means the
observed implementation has a material security or integrity risk. `UNKNOWN`
means repository evidence is insufficient.

### Core and swarm

| Capability | Status |
|---|---|
| Ruflo runtime | IMPLEMENTED |
| ReAct loop | PARTIAL |
| Planner | IMPLEMENTED |
| Agents | PARTIAL |
| Task decomposition | PARTIAL |
| Limits/retries/timeouts | PARTIAL |
| Cancellation | MISSING |
| Sequential execution | IMPLEMENTED |
| DAG/task graph | MISSING |
| Dependencies | MISSING |
| Parallel execution | MISSING |
| Concurrency limits | PARTIAL |
| Agent specialization | PARTIAL |
| Failure isolation | PARTIAL |
| Result aggregation | PARTIAL |
| File locking | MISSING |
| Conflict detection | PARTIAL |

### Safety and patch/recovery

| Capability | Status |
|---|---|
| Path traversal protection | PARTIAL/UNSAFE |
| Workspace boundaries | PARTIAL/UNSAFE |
| Binary restrictions | PARTIAL |
| Secret protection | PARTIAL/UNSAFE |
| Tool permissions | IMPLEMENTED |
| Prompt-injection protection | MISSING/UNSAFE |
| Session authorization | PARTIAL |
| Approval enforcement | IMPLEMENTED |
| Commit approval | IMPLEMENTED |
| Push approval | IMPLEMENTED |
| Runtime/tool/token limits | PARTIAL |
| ChangeProposal | IMPLEMENTED |
| Add/modify/delete/rename | PARTIAL |
| Diff tracking | PARTIAL |
| Rollback | IMPLEMENTED/PARTIAL |
| Validation | PARTIAL |
| Fixer | PARTIAL |
| Retry/recovery | IMPLEMENTED |
| Re-approval | IMPLEMENTED |

### Memory

| Capability | Status |
|---|---|
| Persistent memory | IMPLEMENTED |
| Project/session scope | PARTIAL |
| Keyword search | MISSING |
| Semantic/vector search | MISSING |
| Embeddings | MISSING |
| Deduplication | IMPLEMENTED |
| Relevance/confidence | PARTIAL |
| Success/failure learning | PARTIAL |
| Secret filtering | PARTIAL/UNSAFE |

### Providers and tools

| Capability | Status |
|---|---|
| Gemini | IMPLEMENTED |
| Groq | IMPLEMENTED |
| OpenAI | MISSING |
| Anthropic | MISSING |
| Cohere | MISSING |
| Ollama/local | MISSING |
| Fallback | PARTIAL |
| Model routing | PARTIAL |
| Token/cost tracking | PARTIAL |
| Existing Ruflo tools | IMPLEMENTED |
| Tool registry | PARTIAL |
| MCP | MISSING |
| Permissions | IMPLEMENTED |
| Risk levels | PARTIAL |
| Timeouts | PARTIAL |
| Audit logging | PARTIAL |

### Git/GitHub and streaming

| Capability | Status |
|---|---|
| Repository/branch handling | IMPLEMENTED/PARTIAL |
| Diff | IMPLEMENTED |
| Commit | IMPLEMENTED |
| Push | IMPLEMENTED |
| Authentication | IMPLEMENTED/PARTIAL |
| Secret protection | PARTIAL |
| Commit approval | IMPLEMENTED |
| Push approval | IMPLEMENTED |
| Force-push protection | IMPLEMENTED |
| Remote SHA verification | IMPLEMENTED for Ruflo / PARTIAL overall |
| Polling | IMPLEMENTED |
| SSE | IMPLEMENTED/PARTIAL |
| WebSocket | MISSING |
| Event storage | PARTIAL |
| Reconnect/fallback | PARTIAL |

### Testing, automation, and frontend

| Capability | Status |
|---|---|
| Unit/integration tests | PARTIAL |
| Ruflo tests | IMPLEMENTED |
| Typecheck | IMPLEMENTED as a script |
| Build | IMPLEMENTED as a script |
| Lint | MISSING |
| Playwright/Cypress/E2E | MISSING |
| Workers | PARTIAL |
| Scheduler/cron | MISSING |
| Queues | MISSING |
| Event-driven jobs | MISSING |
| Ruflo mode | IMPLEMENTED |
| Session UI | PARTIAL |
| Activity UI | IMPLEMENTED |
| Agents UI | PARTIAL |
| Tasks UI | PARTIAL |
| Proposal/approval UI | IMPLEMENTED |
| Validation UI | IMPLEMENTED/PARTIAL |
| Git UI | IMPLEMENTED |
| Cost UI | MISSING |
| Memory UI | PARTIAL |
| Workers UI | PARTIAL |
| Streaming UI | PARTIAL |

## 17. Dependencies/Risks

### Architectural dependencies

1. **Durability depends on database design:** schema tables exist, but live
   runtime/proposal/approval state is not represented completely in the
   database. A future durable session design must preserve exact proposal,
   approval, repository-head, workflow, and event state.
2. **Swarm work depends on explicit task semantics:** the current Ruflo plan is
   flat and sequential. DAG execution should not be inferred from the Normal
   Agent's `workerState.dependencies`.
3. **Safe local writes depend on canonical path handling:** patch execution,
   local workspace APIs, validation traversal, preview execution, and proposal
   review need one realpath-aware workspace boundary.
4. **Provider expansion affects routing and budgets:** provider interface,
   model registry, fallback policy, metrics, context limits, and frontend model
   display are coupled.
5. **Streaming depends on durable event identity:** polling can show current
   state but cannot provide reliable replay/reconnect until event storage has
   sequence/cursor semantics.

### Highest regression risks

- changing shared `approval-gate.ts`, `patch-executor.ts`, validation, or GitHub
  policy can affect both Normal Agent and Ruflo;
- process-local maps behave differently after restart or under multiple API
  instances;
- undocumented Ruflo session/execute APIs can drift from the frontend because
  they are not covered by generated OpenAPI client types;
- database `rufloTasksTable` and public Ruflo task types can diverge from live
  runtime behavior because no observed route creates or serves live Ruflo tasks;
- timeout races can leave provider or filesystem work running after Ruflo
  reports a deadline;
- localStorage UI state can remain stale relative to repository branch,
  proposal hash, or remote Git state;
- no frontend lint/browser gate automatically catches UI/API lifecycle drift.

## 18. Recommended Phase Order

This is an audit recommendation only; no phase was implemented here.

### Phase 1 — Safety and lifecycle foundation

1. Establish canonical realpath/symlink-safe workspace confinement.
2. Add explicit cancellation and abort propagation through provider, tool,
   validation, preview, and Ruflo session layers.
3. Persist or transactionally bind live sessions, proposals, approvals, locks,
   workflow phases, and event cursors.
4. Add CSRF/origin policy and session/report ownership binding.
5. Define a single untrusted repository-content/provenance boundary and
   independent prompt-injection defenses.
6. Apply consistent secret redaction to local workspace context, diagnostics,
   tool outputs, and logs.

### Phase 2 — Durable contract and verification boundary

1. Add Ruflo session start/get/execute schemas to OpenAPI and generated clients.
2. Define versioned public Ruflo session/event shapes.
3. Add HTTP integration tests for ownership, stale approvals, restart behavior,
   and concurrent execution.
4. Add frontend lint and browser/E2E coverage for mode selection, polling,
   approval, recovery, commit, and push.

### Phase 3 — Swarm model

1. Introduce explicit task IDs, dependency edges, task states, and durable
   execution leases.
2. Add bounded concurrency and per-task cancellation/timeouts.
3. Add worker specialization contracts, result aggregation, file locks, and
   conflict detection/resolution.
4. Keep the existing sequential Ruflo path as a safe fallback until DAG and
   parallel paths have independent verification.

### Phase 4 — Memory and provider capabilities

1. Add memory query relevance and confidence before adding semantic search.
2. Decide whether embeddings/vector storage belongs in the database or an
   external service; preserve project/user isolation and bounded context.
3. Add outcome-linked success/failure learning with explicit retention rules.
4. Add provider routing/fallback policy and true token/cost accounting before
   exposing cost budgets in the UI.
5. Add additional providers only behind the same model allowlist and safety
   policy.

### Phase 5 — Events, workers, and frontend completion

1. Add durable event sequences, replay cursors, reconnect behavior, and
   backpressure.
2. Introduce durable queues/workers only after cancellation and authorization
   semantics are established.
3. Expose task graph, agent executions, memory facts, cost, worker state, and
   event connection state in the frontend.
4. Add operational limits, metrics, and audit-log views without exposing raw
   prompts, secrets, or untrusted provider output.

## Audit Conclusion

The repository has a meaningful Ruflo Mode 5 foundation: bounded inspection,
structured role stages, persistent bounded hints, explicit approvals, safe
proposal application, recovery/reapproval, validation, and protected GitHub
commit/push flows. The verified baseline is best described as a **bounded,
sequential, approval-gated coding workflow**, not a complete Ruflo swarm
architecture. The capability gaps and security risks above should be resolved
in the recommended order before adding parallel swarm behavior or broader
automation.