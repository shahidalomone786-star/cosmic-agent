# Ruflo / Cosmic Agent Parity Gap Report

**Audit date:** 2026-09-05  
**Audited original revision:** `db4991967c45c6f72133dff0bb80b0a492960fc1`  
**Scope:** Read-only comparison of the current Cosmic Agent Ruflo Mode against the original Ruflo source at the audited revision.

## 1. Executive summary

Cosmic Agent is not a drop-in port of Ruflo. It is a security-bounded orchestration product that borrows Ruflo concepts, selected tool names, agent roles, swarm primitives, and plugin provenance while routing execution through Cosmic Agent's own authenticated sessions, repository proposal flow, approvals, persistence, and audit boundary.

The current implementation has a real, integrated Ruflo-shaped runtime:

- 378 unified Ruflo registry identifiers;
- 300 enabled registry entries;
- 78 explicitly disabled entries;
- 7 behavior-tested native handlers;
- 293 Cosmic adapters, 38 metadata-only entries, and 40 explicitly disabled
  implementation classifications;
- 277 original primary declarations audited;
- 91 additional MIT plugin declarations audited;
- authenticated sessions, bounded jobs, durable memory, workflow phases, Git/GitHub review gates, approval-bound writes, audit records, and a live UI;
- 5 focused Phase 10 tests, 6 focused Phase 11 tests, 6 Phase 9 tests, and 159 full API tests passing in the current verification;
- typecheck, build, LSP, startup, and diff checks passing in the prior verification.

Those counts must not be interpreted as 300 implementations of original Ruflo behavior. Only 7 entries currently have explicit native handlers and behavior tests. A large portion of the Phase 10 surface is a provenance-preserving, bounded evidence adapter: it validates a schema, records authorization and audit metadata, and returns a bounded adapter result. It does not reproduce the original algorithm, provider, external service, worker, CLI, or side effect. Generic adapters are therefore classified as **PARTIAL** or **METADATA-ONLY**, not as full parity.

The most important parity conclusions are:

1. **Core Cosmic Agent execution and safety architecture is intentionally different.** Proposal creation, user approval, repository snapshot binding, apply, commit, push, durable sessions, and the live UI are Cosmic Agent capabilities, not original Ruflo parity.
2. **The original Ruflo runtime is substantially broader.** It includes native MCP servers and tools, a large CLI, browser automation, terminal and shell execution, workers and hooks, federation, SONA and ReasoningBank learning, plugin runtimes, marketplace/IPFS surfaces, WASM agents, hive-mind authority, and many provider integrations.
3. **The current catalog gives good provenance coverage but not behavioral parity.** Original source paths are represented, while many original capabilities are intentionally disabled or reduced to bounded evidence.
4. **Phase 11 establishes a narrow native slice.** `system_status`, `system_metrics`, `system_health`, `system_info`, `mcp_status`, `task_summary`, and `workflow_validate` have server-owned handlers, bounded inputs/outputs/timeouts, correlated redacted audit records, and focused tests.
5. **Some original authority surfaces should not be copied into Cosmic Agent.** Unrestricted shell/browser access, arbitrary network access, native process spawning, marketplace/IPFS transfers, unbounded federation, WASM execution, and autonomous write authority conflict with the existing approval and security model.
6. **Parity work should be selective.** The highest-value compatible additions are read-only introspection, bounded tool semantics, workflow/worker observability, explicit provider and memory interfaces, and a compatibility layer that clearly distinguishes adapted tools from original implementations.

## 2. Method and evidence standard

### 2.1 Sources reviewed

The comparison used:

- the original Ruflo checkout at the exact audited revision;
- `artifacts/api-server/src/ruflo/RUFLO_ORIGINAL_GAP_AUDIT.md`;
- `artifacts/api-server/src/ruflo/RUFLO_PHASE8_STATUS.md`;
- `artifacts/api-server/src/ruflo/RUFLO_PHASE9_STATUS.md`;
- `artifacts/api-server/src/ruflo/RUFLO_PHASE10_STATUS.md`;
- the current Ruflo runtime, registry, Phase 10 catalog and execution adapters;
- current specialized agents, workflow, jobs, audit, provider, memory, route, schema, and Cosmic Agent UI files;
- the prior Phase 9 and Phase 10 verification results.

The original source evidence includes 39 plugin manifests, 59 plugin agent Markdown files, 51 plugin command Markdown files, 145 plugin skill files, 48 native MCP tool source files, and source paths for CLI, browser, federation, provider, SONA, ReasoningBank, workflow, hook, worker, and security functionality.

### 2.2 Classification

Every finding in this report uses exactly one of the following classifications:

- **MISSING** — no current implementation or compatible runtime path was found.
- **PARTIAL** — a compatible subset exists, but semantics, scope, or side effects differ materially.
- **DISABLED** — the capability is represented or classified but deliberately cannot execute.
- **METADATA-ONLY** — source identity, schema, labels, or provenance is present without the original behavior.
- **IMPLEMENTED** — the current system provides a materially equivalent, integrated capability within the current product boundary.
- **NOT VERIFIED — INSUFFICIENT EVIDENCE** — the available source and current code evidence was not enough to make a reliable classification.

“Enabled” in the Phase 10 catalog means eligible for the current bounded adapter route. It does not mean original implementation parity.

## 3. High-level parity matrix

| Area | Classification | Current evidence | Original Ruflo evidence / gap |
|---|---|---|---|
| Unified tool registry and schemas | PARTIAL | `ruflo-tool-registry.ts`, `ruflo-phase10-catalog.ts`, `ruflo-phase11-native.ts`, `ruflo-runtime.ts` | All entries now carry implementation classification and limits, but most remain adapters or disabled metadata. |
| Original native MCP tool behavior | PARTIAL | 7 bounded native handlers plus Phase 10 adapters | 48 native MCP source files under `v3/@claude-flow/cli/src/mcp-tools/`; only a narrow read-only subset has behavior-level coverage. |
| Tool permissions, authorization, and audit | IMPLEMENTED within Cosmic boundary | Runtime authorization and audit records; Phase 10 tests | Not a direct Ruflo parity claim; this is a stronger/different Cosmic safety boundary. |
| Agent metadata | METADATA-ONLY / PARTIAL | Specialized agents and imported catalog metadata | Original plugin agents, CLI agents, and runtime agent implementations are not all executable. |
| Specialized test/documentation/Git/browser agents | PARTIAL | `ruflo-specialized-agents.ts`, `runRufloSpecializedDag` | Original agents and plugin agents have different prompts, tools, and runtime semantics. |
| Swarm messaging, leases, blackboard, topology, bounded consensus | IMPLEMENTED within Cosmic boundary | Phase 8 durable swarm implementation | Not equivalent to all original hive-mind/swarm authority paths. |
| Native agent spawning and autonomous agent execution | DISABLED | Catalog classifications and runtime boundaries | Original native spawning/hive-mind authority is intentionally not imported. |
| Memory persistence and retrieval | PARTIAL | `memory-store.ts`, route memory operations, runtime memory tools | Ruflo includes multiple memory systems, vector/semantic paths, ReasoningBank, and namespace behavior beyond current store. |
| RAG/vector/embedding pipeline | MISSING / NOT VERIFIED | No verified equivalent for the original complete pipeline | Original source contains memory/vector/embedding-related paths; current semantic behavior was not proven equivalent. |
| Learning / SONA / ReasoningBank | DISABLED / MISSING | Metadata and bounded memory only | Original learning and adaptive routing surfaces are not executed. |
| Jobs and bounded execution | IMPLEMENTED within Cosmic boundary | `ruflo-jobs.ts`, session routes, abort/time limits | Different from the original worker/process model. |
| Original workers and hooks | MISSING / METADATA-ONLY | No equivalent worker/hook runtime verified | Original worker and hook source paths exist; current lifecycle events are not parity. |
| Workflows | PARTIAL | `ruflo-workflow.ts`, `runRufloPostApproval` | Current flow is Cosmic proposal approval/post-approval, not Ruflo's full workflow engine. |
| Browser automation | PARTIAL | Safe public HTTPS browser-lite plus specialized browser policy | Original browser drivers/actions are broader; unrestricted automation is intentionally unavailable. |
| Terminal / shell | PARTIAL | Fixed-command sandbox in `ruflo-phase10-execution.ts` | Original terminal/shell tools are broader and intentionally reduced. |
| Git/GitHub read/review/write | PARTIAL / IMPLEMENTED for Cosmic flow | `github-write-provider`, proposals, approval-bound apply/commit/push | Cosmic Git safety is integrated but not original Ruflo Git tool parity. |
| Plugin records and tool IDs | METADATA-ONLY / PARTIAL | 91 plugin declarations in catalog | Plugin manifests/source are not plugin runtime parity. |
| Plugin execution | MISSING | No verified plugin loader/runtime equivalent | Original plugin packages have their own implementation and dependency behavior. |
| Security boundary | IMPLEMENTED within Cosmic boundary | Authenticated routes, approval binding, audit, bounded adapters | Intentionally stronger/different than many original authority surfaces. |
| Observability | PARTIAL | Live events, jobs, audit, session state | Original telemetry, worker tracing, metrics, and health surfaces are broader. |
| Provider routing | PARTIAL | `ruflo-provider-router.ts` / provider gateway | Original provider adapters, CLI configuration, and external model/tool ecosystem are broader. |
| Federation / distributed runtime | DISABLED / MISSING | No enabled federation authority | Original federation, remote coordination, and transport surfaces are intentionally excluded. |
| CLI / commands / skills | MISSING / METADATA-ONLY | Web UI and HTTP routes; imported command/skill provenance | Original CLI command and skill runtime is not present. |
| Cosmic Agent UI | IMPLEMENTED as Cosmic capability | `App.tsx`, `change-proposal-review.tsx`, session/live review UI | No original Ruflo equivalent for this product-specific approval UX. |

## 4. Tools and execution model

### 4.1 Registry coverage

**Classification: PARTIAL**

Current evidence:

- `artifacts/api-server/src/ruflo/ruflo-phase10-catalog.ts` defines the Phase 10 declarations and provenance.
- `artifacts/api-server/src/ruflo/ruflo-tool-registry.ts` merges the catalog into the unified registry.
- `artifacts/api-server/src/ruflo/ruflo-runtime.ts` performs lookup, authorization, audit, and dispatch.
- The verified inventory is 378 identifiers, of which 300 are enabled and 78 disabled. The implementation classification is 7 native, 293 cosmic-adapter, 38 metadata-only, and 40 disabled.

The registry is a useful compatibility and governance layer. It preserves original source references, names, schemas, permissions, limits, and availability decisions. It is not equivalent to loading the original tool implementation. The current adapter route intentionally returns bounded evidence for many declarations. The report therefore counts this as partial parity, not full parity.

Parity requirement:

1. Keep one canonical registry.
2. Add an explicit implementation-kind field such as `native`, `cosmic-adapter`, `metadata-only`, or `disabled`. **Completed in Phase 11.**
3. Require a native handler contract and behavior tests before classifying an entry as **IMPLEMENTED**. **Completed for the 7 native entries; remaining entries are not promoted.**
4. Keep source provenance separate from implementation provenance.
5. Do not advertise catalog count as native tool count.

Priority: **P0 for reporting correctness; P1 for extending compatible native read-only tools.**

### 4.2 Native MCP tools

**Classification: MISSING / PARTIAL**

Original evidence:

- `v3/@claude-flow/cli/src/mcp-tools/` contains 48 native MCP tool source files.
- The original source includes native MCP registration, schemas, handlers, and tool-specific behavior.

Current evidence:

- The current unified registry has a small set of actual Cosmic runtime handlers.
- Many original MCP declarations are represented by Phase 10 catalog entries and a generic bounded adapter.
- Current adapter execution is not a source-compatible port of the original MCP handler, state model, external integrations, or result semantics.

Parity requirement:

- Implement only compatible, read-only native tools first.
- Preserve original input/output semantics only where they can be safely bounded.
- Put all mutations behind existing server-owned proposal, approval, and audit controls.
- Mark each native implementation independently; do not promote an entire source family based on catalog presence.

Priority: **P1 for read-only inspection; P2 for any stateful or external-service tool.**

### 4.3 Authority tools and mutations

**Classification: DISABLED / PARTIAL**

The current catalog intentionally disables or constrains authority-heavy surfaces including native agent spawning, unrestricted execution, hive-mind authority, federation, marketplace/IPFS transfers, WASM agents, and claim mutations. Some names such as policy, workflow, or claim reads remain represented through bounded adapters.

This is an intentional security difference, not an accidental missing feature. The current runtime's authority belongs at the authenticated server boundary, not in a client-requested arbitrary tool call.

Parity requirement:

- Preserve disabled status unless a capability can be bound to a user, session, repository snapshot, explicit approval, timeout, resource budget, and audit record.
- Never treat a generic evidence response as a policy mutation or successful external side effect.

Priority: **P0 to preserve.**

## 5. Agents and swarm architecture

### 5.1 Specialized agents

**Classification: PARTIAL**

Current evidence:

- `artifacts/api-server/src/ruflo/ruflo-specialized-agents.ts` defines `RufloTestGeneratorAgent`, `RufloDocumentationAgent`, `RufloGitIntelligenceAgent`, `RufloBrowserAgent`, `runRufloSpecializedDag`, and bounded browser URL validation.
- `artifacts/api-server/src/routes/ruflo.ts` enqueues specialized work through `rufloJobManager`, limits roles, bounds task/files/URLs/actions, and routes proposal creation through `createRufloProposal`.

These agents are integrated and bounded, but they are Cosmic Agent agents. Their inspection context, proposal creation, browser actions, retry model, and result objects do not reproduce the full original Ruflo agent runtime or plugin agent behavior.

Original evidence:

- Original plugin agent Markdown files and agent source paths document a substantially larger set of specialized roles and capabilities.
- Original CLI and agent runtime paths support agent registration, selection, execution, and tool access that are not all available here.

Parity requirement:

- Maintain a role-by-role mapping to original source declarations.
- Distinguish “same role label” from “same tool/prompt/state semantics.”
- Add behavior-level tests before claiming parity.

Priority: **P1 for explicit role mappings; P2 for additional compatible read-only roles.**

### 5.2 Swarm, hive-mind, and consensus

**Classification: PARTIAL**

Current evidence:

- Phase 8 provides authenticated durable swarm sessions, messaging, blackboard state, leases, topology, and bounded consensus.
- Current swarm behavior remains inside Cosmic session ownership and server-side authorization.

Original evidence:

- Original Ruflo contains hive-mind, queen/worker, consensus, topology, and distributed coordination source.
- Some original paths grant or assume authority to spawn, direct, coordinate, or mutate agent work beyond the current approval boundary.

The current implementation is a compatible bounded subset, not full hive-mind parity. It is preferable for Cosmic Agent because it preserves user ownership, bounded leases, auditability, and explicit authority.

Parity requirement:

- Add only read-only topology/inspection parity first.
- Keep autonomous agent spawning, arbitrary remote workers, and authority-heavy consensus disabled unless the approval model is extended deliberately.
- Document that Phase 8 consensus is not a claim of original hive-mind parity.

Priority: **P0 for documentation; P2 for safe inspection parity.**

### 5.3 Native agent spawning and WASM agents

**Classification: DISABLED**

Original source evidence includes native agent spawning and WASM-related agent surfaces. Current Phase 9/10 provenance preserves their identity but does not execute them.

Reason:

- Native process spawning can escape the bounded job and approval model.
- WASM modules may introduce code execution and resource isolation requirements not present in the current runtime.
- Autonomous agent creation would bypass server-owned ownership and audit decisions.

Parity requirement if ever reconsidered:

- Separate isolated execution service, capability manifest, resource quotas, signature/provenance checks, cancellation, per-user ownership, and approval binding.
- Do not implement inside the current generic adapter route.

Priority: **P0 to remain disabled.**

## 6. Memory, RAG, and learning

### 6.1 Durable memory

**Classification: PARTIAL**

Current evidence:

- `artifacts/api-server/src/ruflo/memory-store.ts` provides `RufloMemoryStore`, project keys, remember/retrieve/list/cleanup operations, confidence/importance/outcome fields, and database-backed persistence.
- `artifacts/api-server/src/routes/ruflo.ts` exposes memory retrieval and stores bounded facts from specialized execution.
- `ruflo-runtime.ts` routes memory tools through the current server-owned store.

Original evidence:

- Original Ruflo contains multiple memory-related paths, namespace/state handling, semantic/vector retrieval, ReasoningBank, and learning-oriented storage.

The current store is integrated and durable, but it is not proven equivalent to all original stores, index strategies, embedding semantics, namespace conventions, consolidation logic, or retention behavior.

Parity requirement:

- Map each original memory namespace and operation to a current behavior.
- Document which retrieval is lexical, structured, vector, or provider-assisted.
- Preserve user/project ownership and do not import unbounded cross-project memory.

Priority: **P1.**

### 6.2 RAG, vectors, embeddings, and semantic search

**Classification: MISSING / NOT VERIFIED — INSUFFICIENT EVIDENCE**

Original evidence includes memory/vector/embedding and semantic-search source paths. The available current evidence proves durable memory retrieval, but not a full original-equivalent vector index, embedding provider contract, chunking pipeline, persistence lifecycle, or ranking behavior.

Parity requirement:

- Specify the index, embedding model/provider, chunking, filtering, ownership, deletion, and ranking contracts before implementing.
- Add fixture-based retrieval tests against known documents.
- Keep embeddings and retrieved content inside the same user/project authorization boundary.

Priority: **P1 for a real RAG product feature; otherwise document as out of scope.**

### 6.3 SONA, ReasoningBank, and adaptive learning

**Classification: DISABLED / MISSING**

Original source evidence includes SONA and ReasoningBank learning paths. Current Cosmic memory confidence/importance/outcome fields are not equivalent to adaptive policy learning, neural routing, episodic learning, or self-optimizing model behavior.

The current system should not claim that storing successful facts implements SONA or ReasoningBank.

Parity requirement if pursued:

- Make learning opt-in and inspectable.
- Bound training data, retention, model updates, and per-user isolation.
- Require reproducible evaluations and rollback.
- Do not permit learned policy to bypass approval or security checks.

Priority: **P2; disabled by default.**

## 7. Workers, hooks, jobs, and workflows

### 7.1 Jobs and bounded execution

**Classification: IMPLEMENTED within Cosmic boundary**

Current evidence:

- `ruflo-jobs.ts` and the Ruflo routes provide queued jobs, ownership checks, retries, cancellation, runtime limits, and session association.
- Specialized DAG execution is bounded and emits live events.

This is a strong integrated capability, but it is not original worker parity. It is the Cosmic execution substrate used to safely host selected Ruflo-shaped work.

### 7.2 Original workers and hooks

**Classification: MISSING / METADATA-ONLY**

Original source paths include worker and hook systems. The current job manager, live events, and post-approval workflow are not equivalent to loading original worker classes, hook registration, hook ordering, hook payloads, worker pools, or worker lifecycle semantics.

Parity requirement:

- First implement read-only lifecycle inspection and explicit hook event names.
- Keep hooks unable to mutate repository state or authorization.
- Route any mutation through existing proposal/apply/commit/push controls.

Priority: **P1 for observability; P2 for safe extensions.**

### 7.3 Workflows

**Classification: PARTIAL**

Current evidence:

- `artifacts/api-server/src/ruflo/ruflo-workflow.ts` implements Cosmic post-approval workflow and recovery phases.
- `runRufloPostApproval` runs after an already approved/applied change, with existing Git safety and validation.
- `routes/ruflo.ts` connects sessions, proposals, approvals, and workflow execution.

Original evidence includes broader workflow definitions, execution, orchestration, and command paths. The current workflow is a fixed Cosmic lifecycle, not an arbitrary Ruflo workflow graph or all original workflow actions.

Parity requirement:

- Preserve the distinction between the legacy runtime progress plan and canonical orchestration plan.
- Add a declarative, validated read-only workflow inspection layer before any user-defined workflow execution.
- Never let a workflow definition bypass approval or invoke arbitrary tools.

Priority: **P1.**

## 8. Browser and terminal

### 8.1 Browser-lite execution

**Classification: PARTIAL**

Current evidence:

- `ruflo-phase10-execution.ts` exposes `openSafeBrowserPage`, `getSafeBrowserPage`, `closeSafeBrowserPage`, and public HTTPS URL validation.
- The safe path rejects private/reserved addresses and uses bounded page/session state.
- `ruflo-specialized-agents.ts` separately provides `RufloBrowserAgent`, `assertAllowedBrowserUrl`, origin allowlisting, action limits, and timeouts.

Original evidence:

- Original Ruflo browser source includes broader browser drivers, actions, navigation, DOM/page interaction, and automation paths.

The current safe browser path is not full browser automation. The specialized browser path is also intentionally bounded and does not establish parity with the original driver ecosystem.

Parity requirement:

- Keep public HTTPS, DNS/IP, redirect, response-size, timeout, and origin checks at the server boundary.
- Add only explicitly allowlisted read-only actions.
- Do not expose cookies, credentials, private network access, arbitrary JavaScript execution, uploads, downloads, or write actions without a separate security design.

Priority: **P0 to preserve; P2 for additional read-only actions.**

### 8.2 Terminal and shell

**Classification: PARTIAL**

Current evidence:

- `ruflo-phase10-execution.ts` defines `createSandboxedTerminal`, `listSandboxedTerminals`, `closeSandboxedTerminal`, and `runSandboxedTerminal`.
- Commands are fixed/allowlisted, bounded, and audited through the Phase 10 runtime path.

Original evidence:

- Original Ruflo terminal/shell tools support a materially broader command and workspace execution model.

The current terminal is a security adapter, not an original shell runtime.

Parity requirement:

- Keep a fixed command set with explicit arguments, output limits, timeout, working-directory restrictions, ownership, and audit.
- Do not add arbitrary shell strings, pipes, redirections, environment injection, or unrestricted filesystem access as a generic tool.

Priority: **P0 to preserve.**

## 9. Git and GitHub

### 9.1 Cosmic repository flow

**Classification: IMPLEMENTED within Cosmic boundary**

Current evidence:

- `ruflo-proposal.ts` creates bounded proposals.
- `github-write-provider` reads repository status/diff and checks repository permissions.
- `routes/ruflo.ts` binds apply/commit/push operations to explicit review and authorization steps.
- `change-proposal-review.tsx` presents the proposal, files, risk, approval, apply, commit, push, conflict, and recovery states.

This is a complete Cosmic product capability and a deliberate security improvement over an autonomous tool-call model.

### 9.2 Ruflo Git/GitHub parity

**Classification: PARTIAL**

Original evidence includes Git/GitHub tools and CLI paths. Current Git behavior is focused on repository inspection, proposal generation, approval-bound application, commit, and push. It does not reproduce every original Git tool, branch workflow, provider configuration, issue/PR operation, or CLI behavior.

Parity requirement:

- Keep apply, commit, and push approvals distinct and server-bound.
- Bind writes to the exact proposal and repository snapshot.
- Add read-only Git/PR/issue parity before any new mutations.

Priority: **P0 for safety; P1 for read-only compatibility.**

## 10. Plugins, commands, and skills

### 10.1 Plugin inventory

**Classification: METADATA-ONLY / PARTIAL**

The current Phase 10 catalog preserves 91 additional MIT plugin declarations from source paths including:

- `v3/plugins/agentic-qe/src/tools/index.ts` — 15 tools;
- `v3/plugins/perf-optimizer/src/mcp-tools.ts` — 5;
- `v3/plugins/test-intelligence/src/mcp-tools.ts` — 5;
- `v3/plugins/code-intelligence/src/mcp-tools.ts` — 5;
- `v3/plugins/neural-coordination/src/mcp-tools.ts` — 5;
- `v3/plugins/hyperbolic-reasoning/src/mcp-tools.ts` — 5;
- `v3/plugins/quantum-optimizer/src/mcp-tools.ts` — 5;
- `v3/plugins/cognitive-kernel/src/mcp-tools.ts` — 5;
- `v3/plugins/legal-contracts/src/mcp-tools.ts` — 5;
- `v3/plugins/prime-radiant/src/tools/` — 6;
- `v3/plugins/teammate-plugin/src/mcp-tools.ts` — 6;
- `v3/plugins/gastown-bridge/src/mcp-tools.ts` — 8;
- `v3/plugins/financial-risk/src/mcp-tools.ts` — 5;
- `v3/plugins/healthcare-clinical/src/mcp-tools.ts` — 5.

These entries establish provenance, names, schemas, limits, and availability. They do not prove the plugin package, dependencies, runtime state, external service, or algorithm is installed and executable in Cosmic Agent.

Parity requirement:

- Treat plugin metadata and plugin execution as separate capabilities.
- Add a manifest validation and compatibility contract before loading a plugin.
- Require per-plugin permissions, dependency isolation, resource limits, audit, and disable/rollback controls.

Priority: **P0 for accurate labeling; P2 for selected safe plugins.**

### 10.2 Plugin runtime

**Classification: MISSING**

No equivalent plugin loader, lifecycle, dependency graph, extension isolation, plugin configuration store, or plugin-specific execution path was verified. Generic registry adapters are not a plugin runtime.

Do not implement a loader by evaluating arbitrary plugin code in the API process.

Priority: **P2, only after an isolation design.**

### 10.3 CLI commands and skills

**Classification: MISSING / METADATA-ONLY**

Original evidence includes 51 plugin command Markdown files, 145 plugin skill files, and broader CLI command paths. Current Cosmic Agent is driven by web UI and HTTP routes. It does not provide the original command parser, shell command lifecycle, skill discovery, skill invocation, command completion, or CLI configuration semantics.

Parity requirement:

- Build a separate compatibility layer if CLI parity is required.
- Keep skill text/content separate from executable authority.
- Require schemas, user ownership, approval, and audit for skill actions.

Priority: **P2.**

## 11. Security and authority boundaries

### 11.1 Current security boundary

**Classification: IMPLEMENTED within Cosmic boundary**

The current system has a coherent server-owned boundary:

- authenticated session ownership;
- bounded job execution and cancellation;
- tool permission checks;
- proposal creation rather than direct repository mutation;
- approval binding to the exact proposal and repository snapshot;
- distinct Git apply/commit/push approval stages;
- audit records and live execution events;
- fixed-command terminal sandbox;
- public HTTPS browser-lite restrictions;
- disabled authority-heavy surfaces.

This architecture is not a defect caused by missing Ruflo parity. It is the product's intended safety model.

### 11.2 Intentional security differences

The following differences from original Ruflo behavior are intentional and should remain unless separately reviewed:

- no unrestricted shell or terminal command execution;
- no unrestricted browser automation or private-network access;
- no arbitrary HTTP client;
- no autonomous repository writes;
- no native process or agent spawning;
- no unbounded worker/federation execution;
- no marketplace/IPFS transfer authority;
- no WASM agent execution;
- no unsupported hive-mind authority;
- no direct claim/policy mutation through a generic tool;
- no credential or cookie passthrough in browser adapters.

Classification: **IMPLEMENTED as a Cosmic security design; DISABLED for the corresponding original authority surfaces.**

### 11.3 Original capabilities that should not be copied without a new design

These are not ordinary parity gaps:

1. Arbitrary shell commands, because they can escape the repository and process boundary.
2. Browser JavaScript, private-network navigation, credential reuse, or unrestricted downloads/uploads.
3. Native process spawning and autonomous worker creation.
4. WASM or plugin code execution in the API process.
5. Marketplace/IPFS installation or transfer with implicit trust.
6. Federation transports that can cross user/project ownership boundaries.
7. Learned policy or swarm consensus that can approve or apply writes.
8. Direct Git/GitHub mutations without proposal/snapshot/approval binding.

Recommended disposition: retain explicit **DISABLED** entries with provenance and an explanation, rather than deleting them and losing auditability.

## 12. Observability and audit

**Classification: PARTIAL**

Current evidence:

- `ruflo-live-client.ts`-related live session/event plumbing in the current Ruflo routes and UI;
- job status, retries, cancellation, session phases, agent execution records, proposal events, and audit records;
- `App.tsx` displays session progress, event history, context notes, warnings, and recovery states.

Original evidence:

- Original Ruflo includes broader worker/tool telemetry, health/status, metrics, tracing, and runtime diagnostics.

Current observability is sufficient for the Cosmic request/proposal/job lifecycle but not equivalent to all original tool, worker, plugin, provider, and distributed-runtime telemetry.

Parity requirement:

- Add stable correlation IDs across session, job, tool call, proposal, approval, workflow, Git operation, and provider request.
- Expose redacted structured tool inputs/outputs, not secrets or raw credentials.
- Add read-only health and capability reports before adding autonomous runtime controls.

Priority: **P1.**

## 13. Providers and model routing

**Classification: PARTIAL**

Current evidence:

- `ruflo-provider-router.ts` defines `RufloModelRouter`, `RufloProviderGateway`, failure classification, capability inference, and candidate ranking.
- The current application routes model work through the provider gateway and current configured provider surface.

Original evidence:

- Original Ruflo has broader provider adapters, configuration paths, model capability handling, CLI/provider commands, and external model/tool integrations.

The current router is a Cosmic provider abstraction, not full provider parity. Capability inference and cost ranking do not prove that every original provider or fallback behavior exists.

Parity requirement:

- Add provider adapters one at a time behind a common server-owned interface.
- Keep credentials in managed secrets/integrations.
- Record provider/model selection and fallback decisions in redacted audit metadata.
- Test failure classification, retry, timeout, streaming, and capability mismatch behavior.

Priority: **P1.**

## 14. Federation and distributed execution

**Classification: DISABLED / MISSING**

Original source evidence includes federation, remote coordination, transport, and distributed runtime paths. Current Phase 8 swarm is authenticated and durable within the Cosmic product boundary; it is not federation parity.

Reason for disabled status:

- Remote execution expands identity, trust, network, data residency, and cancellation boundaries.
- Current approvals and repository ownership are local/server-bound.
- Federation cannot safely be represented by a generic evidence adapter.

Parity requirement if ever pursued:

- Explicit peer identity and trust model;
- signed capability manifests;
- per-request ownership and authorization;
- encrypted transport;
- replay protection;
- cancellation and timeout propagation;
- cross-peer audit;
- data boundary and residency controls.

Priority: **P0 to remain disabled; P3 for future architecture only.**

## 15. Cosmic Agent capabilities not present in original Ruflo

The following are Cosmic Agent product capabilities or integrations rather than original Ruflo parity:

1. The Cosmic Agent web application and its conversation/session UI.
2. Dedicated application preview routing and preview state.
3. Repository context presentation integrated into chat.
4. Change proposal review UI with file operation grouping, risk presentation, approval, apply, commit, push, conflicts, and recovery.
5. Approval authorization bound to a proposal and repository snapshot.
6. Cosmic session/job persistence and user-owned route model.
7. Server-owned post-approval workflow with Cosmic validation/recovery phases.
8. The current repository/GitHub provider integration and its write safety gates.
9. The current project database schema and durable Cosmic memory records.
10. The current provider gateway and model selector integration.

These should not be described as Ruflo parity features. They are the host product in which selected Ruflo concepts are adapted.

## 16. Redundant infrastructure and architectural incompatibilities

### 16.1 Potentially redundant or overlapping infrastructure

The audit found overlapping concepts that should remain clearly separated or be consolidated deliberately:

- Original Ruflo tool registry versus the current unified Cosmic Ruflo registry.
- Original workflow/runtime plans versus the canonical Cosmic orchestration plan and legacy runtime progress plan.
- Original worker queues versus `ruflo-jobs.ts`.
- Original memory/learning stores versus `memory-store.ts`.
- Original provider routing versus `ruflo-provider-router.ts`.
- Original Git/GitHub mutation paths versus `github-write-provider`, proposal, approval, and review UI.
- Original browser drivers versus safe browser-lite and specialized browser policy.
- Original plugin manifests/tools versus Phase 10 catalog entries.

The safe rule is to keep the Cosmic server-owned implementation as the authority and use original source only as provenance/specification input. Do not run two independent authority systems for the same operation.

### 16.2 Architectural incompatibilities

The following original assumptions are incompatible with the current product boundary:

- arbitrary tool-side side effects conflict with proposal/apply approval;
- autonomous workers conflict with user-owned session and job authorization;
- distributed federation conflicts with local repository ownership and audit;
- plugin code loading conflicts with the API process trust boundary;
- browser credential/session reuse conflicts with public HTTPS browser-lite;
- adaptive learning that can change decisions conflicts with deterministic approval and audit;
- original CLI process assumptions conflict with a web/API artifact model;
- original filesystem assumptions conflict with repository-provider access and bounded inspection.

These incompatibilities should be recorded as design decisions, not hidden as implementation gaps.

## 17. Licensing and reuse concerns

The audited original revision is MIT-licensed, which permits reuse subject to preserving the license and copyright notice and complying with any dependency-specific licenses. This report does not substitute for a complete legal review.

Before copying original implementation code rather than adapting concepts:

- preserve the original MIT notice in the relevant distribution;
- audit transitive dependencies and plugin-specific licenses;
- check whether a plugin brings a different license, model license, dataset license, or service terms;
- avoid copying credentials, fixtures, generated code, or third-party assets whose license is not MIT;
- keep provenance comments/manifests linked to the exact audited revision;
- document modifications if source code is reused;
- do not represent a Cosmic adapter as an original Ruflo implementation.

Current Phase 10 provenance-preserving catalog work is lower risk than copying the original runtime, but plugin runtime reuse would require a separate dependency and license audit.

Classification: **PARTIAL / NOT VERIFIED — INSUFFICIENT EVIDENCE** for complete transitive license parity.

Priority: **P0 before distributing copied implementation; P1 for plugin loading.**

## 18. Findings that remain not verified

The following claims were not promoted to implementation parity because the available evidence was insufficient:

- Full semantic equivalence of the original vector/RAG/embedding pipeline.
- Full ReasoningBank or SONA behavior.
- Exact provider-by-provider compatibility and fallback parity.
- Exact original hook ordering and worker lifecycle semantics.
- Complete original CLI command behavior and skill invocation semantics.
- Complete original plugin dependency/runtime behavior.
- Complete original browser-driver action semantics.
- Complete original federation transport, authentication, and failure behavior.
- Complete original metrics/tracing/health output parity.
- Complete transitive license compatibility of all original plugins.
- Production-scale throughput, memory pressure, and multi-tenant isolation equivalence.

These should be labeled **NOT VERIFIED — INSUFFICIENT EVIDENCE** in future status documents until behavior-level tests or source-backed implementation are available.

## 19. Prioritized parity roadmap

This is a comparison outcome, not an implementation request.

### P0 — Preserve the current boundary

- Keep disabled authority surfaces disabled.
- Keep proposal, approval, snapshot, audit, and Git write gates server-bound.
- Keep terminal/browser restrictions.
- Correctly label generic adapters and metadata-only entries.
- Preserve original provenance for disabled capabilities.

### P1 — Improve compatible read-only parity

- Add native read-only MCP/tool handlers with behavior tests.
- Add capability/implementation-kind reporting to the registry.
- Map original memory namespaces and retrieval semantics.
- Add read-only workflow, worker, hook, provider, Git, and plugin inspection.
- Improve correlation IDs and redacted observability.
- Add explicit role-by-role specialized-agent parity documentation.

### P2 — Selective bounded extensions

- Add more read-only browser actions.
- Add carefully bounded terminal commands only when a concrete use case exists.
- Add isolated, allowlisted plugin adapters rather than an in-process plugin loader.
- Add selected CLI/skill compatibility through a schema-first server API.
- Add opt-in, inspectable learning experiments without authority over approvals.

### P3 — Separate architecture projects

- Federation.
- Remote workers.
- WASM agents.
- Marketplace/IPFS/plugin installation.
- Full browser automation.
- Autonomous learning or consensus with authority.

These should not be added as ordinary Phase 10 tools.

## 20. Final assessment

Cosmic Agent currently provides a credible, secure, integrated Ruflo-inspired execution layer, but it does not provide full behavioral parity with original Ruflo. The implementation is best described as:

> **A provenance-preserving, security-bounded Ruflo compatibility layer hosted inside Cosmic Agent, with selected native capabilities and many explicit adapters or disabled declarations.**

That description is accurate and defensible. Claiming that the 378 registry identifiers or 300 enabled entries are 378/300 original Ruflo implementations would not be evidence-based.

The primary remaining gaps are not simply missing names. They are missing original semantics, runtime dependencies, plugin execution, CLI/skill lifecycle, browser/terminal breadth, worker/hook behavior, RAG/learning systems, federation, and provider ecosystem behavior. Several of those gaps are intentional because copying them would weaken the current security architecture.
