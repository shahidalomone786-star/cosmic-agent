# Ruflo Original Repository Gap Audit

**Audit type:** Read-only capability comparison  
**Audit date:** 2026-09-03  
**Current implementation audited:** Cosmic Agent `artifacts/api-server/src/ruflo/` and its Ruflo routes/shared boundaries  
**Original implementation audited:** `https://github.com/ruvnet/ruflo` at commit `db4991967c45c6f72133dff0bb80b0a492960fc1` (2026-09-02)  
**Scope:** Original Ruflo capabilities versus the actual current Cosmic Agent code. No code, configuration, dependency, database, workflow, Normal Agent, commit, or push changes were made by this audit.

## Classification

- **IMPLEMENTED:** The capability exists in Cosmic Agent with a meaningful server/runtime path. This does not necessarily mean feature-for-feature parity with original Ruflo.
- **PARTIAL:** A bounded subset or adjacent capability exists, but important original behavior or scale is absent.
- **MISSING:** No corresponding Cosmic Agent implementation was found.
- **UNSAFE:** A related surface exists, but its current trust, isolation, or authorization boundary is not safe enough to claim parity.
- **UNKNOWN:** The source tree does not prove the capability or its operational/deployment state.

## Executive summary

Cosmic Agent is a real, approval-gated coding and repository automation system with a Ruflo-specific bounded runtime. It now includes a dynamic DAG scheduler, bounded parallel specialized jobs, hybrid memory retrieval, provider routing and budgets, MCP transport support, live events, test/documentation/Git/browser adapters, and separate Git approval stages.

Original Ruflo is materially broader. Its repository describes a full CLI/MCP/plugin ecosystem with approximately 210 tools, 100+ specialized agents, multiple swarm topologies and consensus strategies, shared agent communication, AgentDB/HNSW vector memory, SONA/ReasoningBank learning, federation, recurring workers/autopilot, browser tooling, a plugin marketplace, local ruvLLM, and workflow/GOAP goal surfaces.

The central gap is architectural: Cosmic Agent’s new multi-agent features are bounded, authenticated, server-controlled and mostly in-process. They are not yet the original Ruflo’s installable, extensible, distributed swarm platform. The most urgent concerns are not cosmetic parity gaps: untrusted MCP/browser execution, prompt-injection/provenance controls, validation isolation, and process-local authorization/state make some existing adjacent surfaces **UNSAFE** or operationally fragile.

## Original Ruflo baseline

Evidence was taken from the original repository README and plugin READMEs/source, not from marketing claims alone where a plugin contract or source path was available.

| Original capability | Original evidence |
|---|---|
| Full CLI/MCP loop | Root `README.md`; `ruflo/` package and CLI surface |
| Approximately 210 tools | Root `README.md`, “~210 tools, ready to call”; five server groups plus browser tool gallery |
| 100+ specialized agents | Root `README.md`; `v3/agents/` and plugin agent definitions |
| 35 plugins in the repository | `plugins/` directory at the audited commit; README says “All 35 plugins” |
| Swarm teams, topology, worktrees and consensus | `plugins/ruflo-swarm/README.md` |
| Vector/RAG memory and HNSW/AgentDB | `plugins/ruflo-rag-memory/README.md`, `plugins/ruflo-agentdb/`, `plugins/ruflo-ruvector/` |
| SONA, ReasoningBank and trajectory learning | Root `README.md`, `plugins/ruflo-intelligence/`, `plugins/ruflo-ruvllm/` |
| Federation across machines | `plugins/ruflo-federation/README.md`, `plugins/ruflo-bbs-federation/` |
| Autopilot and recurring workers | `plugins/ruflo-autopilot/README.md`, `plugins/ruflo-loop-workers/README.md` |
| Browser/Playwright-style automation | `plugins/ruflo-browser/`, browser MCP/Servo references under `ruflo/docs/adr/` |
| Test generation and documentation automation | `plugins/ruflo-testgen/`, `plugins/ruflo-docs/` |
| Git intelligence and related Git/Jujutsu tooling | `plugins/ruflo-intelligence/`, `plugins/ruflo-jujutsu/`, Git-related CLI/MCP tools |
| AIDefence/security auditing | `plugins/ruflo-aidefence/`, `plugins/ruflo-security-audit/` |
| Structured observability | `plugins/ruflo-observability/README.md` |
| Installable plugin/marketplace model | `plugins/`, `.claude-plugin/`, plugin creator/marketplace docs |
| Local ruvLLM and MicroLoRA | `plugins/ruflo-ruvllm/README.md` |
| Persisted workflows and GOAP goals | `plugins/ruflo-workflows/`, `plugins/ruflo-goals/`, goal UI references in root README |

Original tool and agent counts are repository-level capability claims. This audit does not independently reproduce every original tool or benchmark; it compares the audited original source surface with the current Cosmic Agent source.

## Capability matrix

### 1. Core orchestration, swarm execution and planning

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| Bounded agent runtime and tool loop | **IMPLEMENTED** — `ruflo-runtime.ts` (`runRufloSession`), `ruflo-planner.ts` (`ModelRufloPlanner`), server-validated actions, read tools, proposal boundary, approval/apply/validate/Git workflow | Not full original autonomous loop; free-form orchestration, durable run state and broad tool routing remain absent | P1 |
| DAG/task decomposition and dependency scheduling | **PARTIAL** — `ruflo-dag.ts` (`RufloTaskGraph`, `RufloDynamicDagScheduler`) validates dependencies/cycles, bounds concurrency, isolates failures, locks/conflicts and aggregates results; specialized jobs use it | Durable graph persistence, distributed leases, cross-instance scheduling and integration with the primary flat planner plan are missing. Depends on durable orchestration storage and cancellation propagation | P1 |
| Swarm topologies | **MISSING** — no Ruflo hierarchical, mesh, hierarchical-mesh, ring, star or adaptive topology engine | Topology model, membership/lifecycle manager, coordinator/peer routing, topology-aware scheduling and durable state. Depends on shared comms and worker leases | P0 |
| Consensus / hive mind | **MISSING** — DAG aggregation is not consensus | Raft/Byzantine/Gossip/CRDT/quorum strategy implementations, voting state, quorum rules, conflict resolution and authoritative result selection. Depends on topology and inter-agent communication | P0 |
| Parallel agent execution | **PARTIAL** — bounded independent DAG/specialized tasks can run concurrently | Original-style independently addressable autonomous agents, isolated worktrees/processes, durable task ownership and broad parallel tool execution are missing. Depends on worker runtime and file/worktree isolation | P1 |
| Adaptive replanning | **PARTIAL** — the runtime asks the planner for a decision on each bounded iteration (`ruflo-runtime.ts`); Normal Agent has separate manager replan concepts that do not count as Ruflo | Plan revision/version events, dependency-aware replan insertion/removal, replanning policy, persisted plan history and user-visible replan state | P1 |
| Cancellation and resumability | **PARTIAL** — specialized jobs expose cancellation; DAG operations accept bounded cancellation signals | Primary Ruflo session has no complete cancel/abort route; provider/tool operations may continue after a timeout; durable resume after restart is missing | P0 |
| File/worktree isolation | **PARTIAL** — in-memory Ruflo locks and path/conflict checks exist | Original swarm worktrees, durable file locks, cross-process locking and transactional multi-agent merge are missing. Depends on Git/worktree service | P1 |

### 2. Agents, communication and shared context

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| 100+ specialized agents | **PARTIAL** — fixed core roles in `ruflo-agents.ts` (planner/coder/reviewer/validator/fixer); specialized roles in `ruflo-specialized-agents.ts` (test generator, documentation, Git intelligence, browser) | Installable/dynamic agent registry, original role catalog, per-agent skills/prompts/tools, capability discovery and agent lifecycle are missing. Depends on plugin/agent registry and worker runtime | P1 |
| Inter-agent messaging | **MISSING** — execution callbacks and task results are passed by the server; no agent mailbox, `SendMessage` equivalent or peer addressability | Authenticated message bus/mailboxes, delivery/ordering/retry, agent identity, message limits and audit trail. Depends on durable session/worker identity | P0 |
| Shared context / blackboard | **PARTIAL** — planner receives bounded repository/memory context; DAG results and memory callbacks share bounded data | No live shared blackboard, namespace-scoped context updates, subscriptions, context conflict policy or cross-agent context handoff. Depends on shared context store and provenance model | P0 |
| Agent result aggregation | **PARTIAL** — `ruflo-dag.ts` aggregates task results/conflicts; specialized executions are recorded | No consensus-based merge, quorum result, agent voting, peer review convergence or topology-aware conflict resolution | P1 |
| Context provenance and anti-drift | **UNSAFE/PARTIAL** — server-controlled tool permissions and approval separation constrain direct effects | Repository/MCP/browser content has no independent provenance/taint boundary or prompt-injection detector. Depends on untrusted-content labeling and model-independent policy enforcement | P0 |

### 3. Memory, RAG, graph and learning

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| Persistent project memory | **IMPLEMENTED** — `memory-store.ts`, `database-session-store.ts`, `ruflo_memory`, scoped facts and sanitization | Full original namespace ecosystem and cross-installation sharing are absent | P1 |
| Hybrid semantic/keyword retrieval | **PARTIAL** — `memory-retrieval.ts` supports keyword and cosine similarity; `embedding-provider.ts` provides an optional HTTP embedding endpoint; Phase 2 fields include vectors/confidence/outcomes | Embeddings are optional; no AgentDB-compatible store, HNSW index lifecycle, ANN tuning, durable retrieval telemetry or guaranteed configured embedding service. Depends on embedding service and vector index/storage | P1 |
| RAG context injection | **PARTIAL** — bounded retrieved memory is injected as lower-priority planner context | No broad document/code indexing pipeline, chunking/refresh strategy, citation/provenance chain or original memory tool family | P1 |
| Knowledge graph | **MISSING** — no entity/relation graph, extraction, traversal or graph namespace was found | Entity/relation schema, extraction agent, graph persistence, traversal/pathfinder, graph embeddings and mutation attestation. Depends on vector/graph storage | P1 |
| SONA / ReasoningBank | **MISSING** — `memory-learning.ts` extracts bounded heuristic success/failure facts; it is not SONA or ReasoningBank | Trajectory capture, pattern discovery, policy/reasoning retrieval, online adaptation, reward/outcome evaluation and model adapter integration. Depends on durable learning store and embedding/model runtime | P1 |
| Adaptive/self-optimizing learning loop | **PARTIAL** — outcomes can become sanitized memory facts | No learned routing/policy update, pattern promotion/consolidation, MicroLoRA/SONA path or benchmarked feedback loop | P2 |

### 4. MCP and the tools ecosystem

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| MCP protocol support | **PARTIAL** — `ruflo-mcp-client.ts` supports stdio and Streamable HTTP JSON-RPC; `ruflo-mcp-manager.ts` discovers, validates, allowlists and executes tools | Original SSE transport is explicitly rejected; no broad native tool groups, browser gallery or bundled server catalog. Depends on transport implementations and safe server lifecycle | P1 |
| Approximately 200–210 native tools | **MISSING/PARTIAL** — current built-in Ruflo executor exposes `inspect_repository`, `search_repository` and `read_file`; configured MCP tools are dynamic rather than a shipped ecosystem | Native Core/Intelligence/Agents/Memory/DevTools tool families, schemas, handlers, docs, namespace ownership and coverage are missing. Depends on plugin/tool registry and many domain implementations | P0 |
| Tool registry and permissions | **PARTIAL** — `ruflo-tool-registry.ts` and MCP manager provide typed registration, owner scope, risk/approval, limits and audit ring | No installable plugin lifecycle, signed manifest, capability negotiation across the full ecosystem or durable policy registry | P1 |
| Parallel tool calling | **PARTIAL** — bounded DAG jobs can run independently; MCP manager limits concurrent calls | No model-level multi-tool response execution comparable to original UI/CLI; no durable fan-out or full tool result aggregation | P1 |
| Tool ecosystem safety | **UNSAFE/PARTIAL** — server-side allowlists and single-use approvals are strong logical controls | MCP stdio children are not sandboxed; HTTP host policy does not fully address private/link-local targets, DNS rebinding or redirect revalidation; configuration/clients/approvals/usage are process-local; output redaction is pattern-based | P0 |

### 5. Federation, workers and automation

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| Cross-machine agent federation | **MISSING** — no peer discovery, federation protocol, remote agent identity or cross-machine task route | Zero-trust peer enrollment, identity/attestation, encrypted transport, capability exchange, remote task/message protocol, ACLs, replay protection and federation audit. Depends on durable identity and event infrastructure | P0 |
| Autopilot / recurring loops | **PARTIAL** — `ruflo-jobs.ts` and Ruflo job routes enqueue, monitor and cancel bounded specialized jobs | No daemon/heartbeat, `ScheduleWakeup`, cron/recurring trigger model, cache-aware loops, pause/resume lifecycle or durable scheduler | P1 |
| Background worker system | **PARTIAL** — specialized roles run through the in-process job manager and bounded DAG; job lifecycle events and activity persistence exist | Original 12 auto-triggered workers, durable queue, worker processes, leases, retry policy by worker, trigger routing and crash recovery are missing | P1 |
| Worker isolation and resource governance | **PARTIAL/UNSAFE** — runtime, tool, task, retry and concurrency limits exist | No process/container isolation, CPU/memory/network quotas, durable leases or descendant-process cleanup; validation executes in project/toolchain context | P0 |

### 6. Browser, tests and documentation

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| Browser/Playwright automation | **PARTIAL/UNSAFE/UNKNOWN** — `ruflo-specialized-agents.ts` exposes a bounded browser adapter with URL/origin/page/action limits; without an installed driver it returns unavailable | No proven Playwright/Servo driver lifecycle, browser session/artifact model or full navigation/action parity. Caller-supplied origins, internal-IP/SSRF/DNS-rebinding protection, redirect revalidation and action approvals are incomplete. Depends on sandboxed browser driver and network policy | P0 |
| Test generation | **PARTIAL** — `RufloTestGeneratorAgent` inspects bounded source context and creates an approval-gated proposal | No full test-gap/coverage analysis, framework-specific generation breadth, original testgen worker/tool family or automatic test execution. Depends on AST/coverage analyzers and sandboxed runner | P1 |
| Test execution / verification | **PARTIAL/UNSAFE** — validator runs bounded `node --check`, TypeScript and Vite checks through `local-validation.ts`; test generator does not execute tests | No general test-suite execution contract, sandbox/resource/network isolation, dependency trust boundary or descendant-process containment. A project toolchain can execute code | P0 |
| Documentation automation | **PARTIAL** — `RufloDocumentationAgent` creates proposal-only documentation changes | No broad docs plugin skills, API/reference generation, doc freshness/link validation, documentation worker triggers or automated publish path | P2 |

### 7. Git intelligence and security

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| Read-only Git intelligence | **PARTIAL** — specialized Git role exposes status, branches, commits, diffs, changed files and authorship-shaped analysis; `github-provider.ts` and Git write provider support bounded repository operations | No full original intelligence/jujutsu surface, semantic history analysis, worktree-aware swarm integration, broad Git CLI/MCP tools or complete ownership graph | P2 |
| Git proposal/commit/push safety | **IMPLEMENTED/PARTIAL** — `ChangeProposal`, approval binding, stale-file checks, separate commit/push approvals, no-force push and remote-head checks | Local/GitHub operation parity is incomplete for delete/rename; state and approvals are process-local; compare/update is not one application-level transaction | P1 |
| AIDefence / input security | **PARTIAL/UNSAFE** — path confinement, protected names, redaction, MCP policy, approval gates and bounded outputs exist | No AIDefence-style prompt/input scanning, CVE remediation workflow, complete secret scanner, provenance/taint model, policy engine or comprehensive security plugin | P0 |
| Prompt-injection defense | **MISSING/UNSAFE** — repository text is bounded and server tools are authoritative, but raw source/comments/tool results enter model context | Independent detector, untrusted-content delimiters/labels, instruction hierarchy enforcement, retrieval provenance and model-independent action policy | P0 |
| Workspace and validation confinement | **PARTIAL/UNSAFE** — normal workspace operations have realpath/ancestor checks after Phase 1 | Validation uses raw path joins and runs with project privileges; TOCTOU and descendant-process risks remain. Depends on a sandboxed validator/executor and atomic filesystem boundary | P0 |

### 8. Observability, plugins, providers and local inference

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| Live agent observability | **PARTIAL** — `ruflo-live-events.ts` provides authenticated bounded SSE-style events; Ruflo activities persist coarse lifecycle records; frontend polls/consumes session state | No durable event replay/cursor, distributed traces, span hierarchy, structured log correlation, anomaly dashboard or complete event history | P1 |
| Security/tool audit | **PARTIAL/UNSAFE** — `ruflo-audit.ts` records bounded in-memory MCP audit entries; activities/events are sanitized | No durable append-only audit containing actor, authorization decision, exact proposal/version/hash, repository SHA, tool input/output evidence and effect; pattern redaction is incomplete | P0 |
| Plugin system / marketplace | **MISSING** — `ruflo-tool-registry.ts` is an in-process registry, not an installable plugin system | Plugin manifest/schema, install/update/remove, signed package verification, dependency/version resolution, sandbox/capability isolation, marketplace/catalog and plugin-owned namespaces | P1 |
| Multi-provider routing | **PARTIAL** — Gemini and Groq providers, capability routing, bounded fallbacks and token/cost budgets exist in `ruflo-provider-router.ts` and `ruflo-cost-tracker.ts` | No concrete Claude/OpenAI/Anthropic/Cohere/Ollama/local provider set matching original Ruflo, no broad OpenAI-compatible endpoint policy and no durable spend ledger | P1 |
| Local ruvLLM | **MISSING** — no local inference transport, ruvLLM runtime, MicroLoRA or SONA adapter path; optional embedding HTTP is not local inference | ruvLLM/model runtime, local model discovery/configuration, CPU/GPU resource management, adapter store, offline routing and security boundary | P1 |

### 9. Workflows and goals

| Original Ruflo feature | Current Cosmic Agent status and evidence | Exact missing components / dependencies | Priority |
|---|---|---|---|
| Ruflo session workflow | **PARTIAL** — planner → bounded tasks → proposal → user approval → apply → validate → Git review/approval lifecycle exists; database session/task/activity tables exist | No general reusable workflow definitions/templates, workflow tool family, durable pause/resume/cancel state machine or cross-session resume | P1 |
| Native workflow fan-out/pipeline | **PARTIAL** — DAG scheduler can run bounded tasks in parallel and aggregate results | No user-authored workflow scripts, schema-validated workflow hooks, deterministic pipeline/barrier API or run replay | P1 |
| GOAP goal planning | **MISSING** — planner uses bounded ordered steps; no GOAP/A* state-space planner or goal UI/API | Goal/state/action model, A* planner, preconditions/effects, multi-agent assignment, goal progress telemetry and durable plan runs | P1 |
| Workflow approvals and human gates | **PARTIAL** — proposal/apply/commit/push approvals are explicit and server-bound | No generic workflow approval nodes, pause/resume semantics or approval state durable across restart | P1 |

## Major implemented features

These are genuine Cosmic Agent capabilities, even where they do not establish original Ruflo parity:

1. **Server-controlled Ruflo runtime** with bounded planner decisions, read-only repository inspection and explicit proposal-ready terminal behavior (`ruflo-runtime.ts`, `ruflo-planner.ts`).
2. **Approval-gated change lifecycle** using `ChangeProposal`, server-held approval binding, apply, validation, rollback/recovery, separate commit approval and separate push approval.
3. **Dynamic bounded DAG scheduler** with dependency/cycle validation, bounded concurrency, retries, cancellation signals, failure isolation, lock cleanup, stale-revision and overlap conflict checks, and structured aggregation (`ruflo-dag.ts`).
4. **Hybrid persistent memory** with sanitized facts, project scoping, optional embeddings, keyword/cosine retrieval, confidence/outcome metadata and bounded planner injection (`memory-store.ts`, `memory-retrieval.ts`, `embedding-provider.ts`).
5. **Ruflo-only provider routing and budgets** across Gemini/Groq with capability classes, fallback classification, usage tracking and configurable token/cost ceilings (`ruflo-provider-router.ts`, `ruflo-cost-tracker.ts`).
6. **MCP adapter** with stdio and Streamable HTTP JSON-RPC, explicit server/tool allowlists, schema validation, permission/risk/approval gates, concurrency/call limits and bounded redacted results (`ruflo-mcp-client.ts`, `ruflo-mcp-manager.ts`, `ruflo-tool-registry.ts`).
7. **Live event and job surfaces** with authenticated session ownership, bounded event payloads, specialized job cancellation and lifecycle activity persistence (`ruflo-live-events.ts`, `ruflo-jobs.ts`, `routes/ruflo.ts`).
8. **Specialized proposal/read adapters** for test generation, documentation, Git intelligence and browser checks (`ruflo-specialized-agents.ts`).
9. **GitHub safety controls** including repository permissions, expected-head comparisons, no-force push, remote-head verification and distinct Git write approvals.
10. **Normal Agent separation intent**: Ruflo has separate routes, runtime types, limits, roles and phases; it shares foundational infrastructure but did not receive Ruflo swarm authority from this audit.

## Major missing features

- Original-scale native MCP/tool ecosystem and installable plugin catalog.
- 100+ dynamic specialized agent definitions and agent lifecycle.
- Inter-agent messaging, shared blackboard/context and addressable teams.
- Named swarm topologies, hive-mind consensus and multi-agent convergence.
- Durable distributed worker runtime, leases, queues, daemon/autopilot and federation.
- Full AgentDB/HNSW RAG pipeline and knowledge graph.
- SONA/ReasoningBank trajectory learning and local MicroLoRA/ruvLLM.
- Generic reusable workflow definitions and GOAP/A* goal planning.
- Full browser driver parity, test execution automation and broader documentation automation.
- Original observability/tracing/metrics depth and durable security audit.

## Inter-agent sharing status

**Classification: MISSING for original Ruflo parity; PARTIAL for bounded server orchestration.**

Cosmic Agent shares bounded input context, planner context, memory retrieval, task results, execution IDs and lifecycle events across server-managed stages. Independent DAG tasks can receive the task/session context and their results can be aggregated.

It does **not** currently provide:

- an authenticated `SendMessage`-style inter-agent bus;
- named agent identities with direct addressing;
- a durable mailbox or blackboard;
- live shared context mutation/subscription;
- consensus or peer voting;
- cross-machine federation;
- durable shared state/leases across restarts or instances.

The current mechanism is therefore coordinator-mediated data passing, not peer collaboration.

## Tool ecosystem status

**Classification: PARTIAL, with an UNSAFE execution boundary requiring hardening before broad expansion.**

- Native Ruflo built-ins in the runtime: `inspect_repository`, `search_repository`, `read_file`.
- Dynamic MCP support: stdio and Streamable HTTP discovery/execution through the Ruflo manager.
- Security controls present: server allowlists, exact tool allowlists, owner/session checks, schema normalization/validation, risk/approval gates, call/concurrency limits and bounded redaction.
- Original parity absent: approximately 210 shipped native tools, the five original tool groups, plugin-owned tool families, browser gallery, full transport coverage including SSE, durable tool policy/configuration and installable tool plugins.
- Safety blockers: stdio is not sandboxed; HTTP/private-network/redirect/DNS-rebinding defenses are incomplete; state is process-local; and audit records are bounded/in-memory rather than a durable authorization/effect ledger.

Configured external MCP tools must not be counted as a shipped Cosmic Agent ecosystem. Their existence and behavior are **UNKNOWN** until a server is configured and its live tool surface is inspected.

## Unsafe and unknown findings

### Unsafe or high-risk current boundaries

1. **MCP execution — UNSAFE/PARTIAL:** untrusted stdio children and remote HTTP servers can execute outside a dedicated sandbox; network target and redirect policy is not a complete SSRF/DNS-rebinding defense.
2. **Browser adapter — UNSAFE/PARTIAL:** caller-supplied URLs/origins and actions lack a complete private-network/redirect policy and action approval boundary; a real browser driver is not proven available.
3. **Repository prompt injection — UNSAFE:** repository files, comments and tool outputs enter model context without independent provenance/taint enforcement or prompt-injection detection.
4. **Validation/test execution — UNSAFE/PARTIAL:** fixed commands reduce shell injection risk but execute in the project/toolchain context without full resource, network, dependency or descendant-process isolation.
5. **Authorization durability — UNSAFE operationally:** runtime sessions, proposals, approvals, locks, jobs, MCP configuration/clients and live events are substantially process-local. Restart or multiple server instances can lose or disagree about state.
6. **Secret protection — UNSAFE/PARTIAL:** known-key redaction exists, but local workspace reads and arbitrary tool/validation output are not a complete secret-scanning boundary.
7. **Audit completeness — UNSAFE/PARTIAL:** in-memory rings and coarse activities do not prove a durable, tamper-evident record of every authorization decision and external effect.

### Unknown from this source audit

- Whether the deployed environment has the required Phase 2 memory columns/migrations.
- Whether a production embedding endpoint is configured and reliable.
- Whether a real browser driver is installed and reachable in the runtime environment.
- Which external MCP servers/tools, if any, are configured in deployment.
- Whether all live-event/job state survives the actual deployment topology.
- Whether current deployment has the required process count, persistence, network policy or sandbox controls.
- Whether original Ruflo’s README-level counts and benchmarks are all enabled in a given original install profile; the comparison uses the audited repository’s documented/source surface, not a full original installation run.

## Highest-priority next features

1. **P0 — Establish a safe execution substrate:** sandbox MCP stdio/HTTP and browser processes, enforce private-network/redirect/DNS-rebinding policy, isolate validation/test execution, add complete provenance/prompt-injection defenses, and make authorization/effect audit durable.
2. **P0 — Build durable inter-agent coordination:** authenticated agent identities, shared context/message bus, durable task leases, cancellation/heartbeats, cross-instance locking and persisted DAG/session state.
3. **P0 — Implement swarm semantics:** topology engine, peer communication, consensus/quorum strategies, result convergence and conflict resolution.
4. **P1 — Expand the worker/plugin/tool platform:** durable queues/autopilot, native tool groups, dynamic specialized agent registry, signed plugin lifecycle and capability policy.
5. **P1 — Complete intelligence parity:** AgentDB/HNSW-grade RAG, knowledge graph, SONA/ReasoningBank trajectories and adaptive replanning.
6. **P1 — Add local/federated execution:** secure federation protocol plus local ruvLLM/MicroLoRA routing and resource governance.
7. **P1/P2 — Broaden product surfaces:** generic workflows/GOAP goals, full test/doc automation, Git intelligence depth and OpenTelemetry-compatible observability.

## Files changed

Only this file was created:

- `artifacts/api-server/src/ruflo/RUFLO_ORIGINAL_GAP_AUDIT.md`

No production code, Normal Agent code, configuration, dependencies, database schema, workflows, commits or pushes were modified.