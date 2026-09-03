# RUFLO Phase 9 Status

**Status:** Implemented as a bounded import/adaptation  
**Audit date:** 2026-09-03  
**Original repository:** `https://github.com/ruvnet/ruflo`  
**Audited revision:** `db4991967c45c6f72133dff0bb80b0a492960fc1`  
**License:** MIT, copyright `ruvnet 2024-2026`

## Scope and verified source inventory

The audited original tree was inspected directly at the revision above. Counts
below are source-tree counts, not README or marketing claims:

| Original source surface | Verified count | Evidence/method |
| --- | ---: | --- |
| Plugin manifests | 39 | `plugins/*/.claude-plugin/plugin.json` |
| Plugin agent Markdown files | 59 | `plugins/*/agents/*.md` |
| Plugin command Markdown files | 51 | `plugins/*/commands/*.md` |
| Plugin skill files | 145 | `plugins/*/skills/*/SKILL.md` |
| Canonical `name:` entries in the native MCP source inventory | 421 | bounded extraction from `v3/@claude-flow/cli/src/mcp-tools/`; this includes aliases and non-tool name-like declarations, so it is not used as an executable-tool count |
| Generated catalog manifest claims | 165 agents / 397 tools / 34 skills | `v3/@claude-flow/cli/catalog-manifest.json`; retained as a reference only because it does not reconcile one-to-one with source declarations |

The source paths most relevant to this phase were:

- `v3/@claude-flow/cli/src/mcp-tools/` — native tool implementations.
- `v3/@claude-flow/mcp/src/tool-registry.ts` — original registry concepts.
- `plugins/*/.claude-plugin/plugin.json` — plugin manifests.
- `plugins/*/agents/*.md` — specialized-agent definitions.
- `plugins/*/commands/*.md` — command definitions.
- `plugins/*/skills/*/SKILL.md` — skills.

## Phase 9 import surface

Phase 9 adds **8 enabled native adapters** to the existing **3 native tools**,
for **11 registered Ruflo tools total**. All 8 adapters are in
`ruflo-phase9-catalog.ts` and carry:

- original repository, audited revision, MIT license, and source path;
- adapted versus metadata-only status;
- explicit risk, permission, approval, timeout, and resource limits;
- Ruflo-only agent access metadata;
- the existing registry schema validation and authorization path;
- the existing bounded executor and audit log.

Enabled adapters:

| Tool | Original source | Cosmic Agent adaptation |
| --- | --- | --- |
| `memory_search` | `v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts` | Existing project-scoped keyword/cosine memory retrieval |
| `memory_store` | `v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts` | Existing sanitized persistent memory writer; explicit approval retained |
| `memory_cleanup` | `v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts` | Existing bounded retention cleanup; explicit approval retained |
| `memory_stats` | `v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts` | Existing persistent memory store health/count surface |
| `agentdb_health` | `plugins/ruflo-agentdb/README.md` | Health view over the existing PostgreSQL memory substrate; no native AgentDB/RuVector runtime |
| `guidance_capabilities` | `v3/@claude-flow/cli/src/mcp-tools/guidance-tools.ts` | Bounded registry, agent, plugin, and exclusion catalog |
| `system_info` | `v3/@claude-flow/cli/src/mcp-tools/system-tools.ts` | Runtime and provenance information |
| `system_health` | `v3/@claude-flow/cli/src/mcp-tools/system-tools.ts` | Bounded runtime/catalog health summary |

## Imported agent metadata

**13 specialized agent definitions** are adapted as metadata and registered in
the existing Phase 8 authenticated swarm capability map:

`researcher`, `coder`, `reviewer`, `tester`, `docs-writer`, `git-specialist`,
`security-auditor`, `memory-specialist`, `goal-planner`, `workflow-specialist`,
`intelligence-specialist`, `browser-agent`, and `sparc-orchestrator`.

Each definition preserves the original plugin/source path and a bounded role
prompt. Every imported agent is marked `rufloOnly: true`, receives only
context/message/consensus capabilities appropriate to its role, and cannot
spawn arbitrary processes, apply repository writes, commit, push, or approve
policy. Agent registration, credential issuance, mailbox access, blackboard
access, leases, heartbeats, topology, and consensus continue to use the Phase 8
service; no second communication system was added.

## Imported plugin capabilities

**15 plugin capability records** are registered:

- Adapted: `ruflo-core`, `ruflo-agentdb`, `ruflo-rag-memory`,
  `ruflo-intelligence`, `ruflo-testgen`, `ruflo-docs`, `ruflo-jujutsu`,
  `ruflo-security-audit`, `ruflo-observability`, `ruflo-swarm`,
  `ruflo-workflows`, `ruflo-goals`, `ruflo-browser`, `ruflo-sparc`.
- Metadata-only: `ruflo-agent` because the original WASM/managed-agent runtime
  is not available inside the current server boundary.

These records map plugin concepts to existing Cosmic Agent systems instead of
installing duplicate registries, schedulers, memory engines, model runtimes,
or swarm transports.

## Explicitly excluded original tools

**7 audited authority-heavy tool definitions** remain visible as disabled
metadata and are not registered as executable tools:

`agent_spawn`, `agent_execute`, `terminal_execute`, `browser_open`,
`workflow_execute`, `federation_bbs_publish`, and `policy_approve`.

The following broader original surfaces also remain out of scope or
metadata-only because they would violate current boundaries or duplicate
existing authority:

- arbitrary terminal execution and unrestricted filesystem writes;
- browser automation and arbitrary network navigation without a dedicated
  SSRF-safe service;
- cross-machine federation, remote peers, attestation, and remote transport;
- native AgentDB/RuVector/HNSW, WASM agents, local-model runtimes, and native
  SONA/ReasoningBank execution;
- marketplace, transfer, autopilot, recurring-worker, and remote orchestration
  systems;
- destructive Git operations, commits, pushes, and policy approval as tools;
- arena/game, neural-trader, and other domain-specific plugin code unrelated to
  Cosmic Agent's coding/repository product.

## Security and isolation

- Adapted calls pass through the existing unified registry schema, permission,
  risk, approval, timeout, and bounded-runtime checks.
- Native execution records authorization, completion, and failure in the
  existing bounded Ruflo audit log.
- Memory operations remain user/project scoped, sanitized, size bounded, and
  governed by the existing retention policy.
- Imported swarm agent types use the existing HMAC-authenticated Phase 8
  identities and capability restrictions.
- Normal Agent routes and capabilities were not changed; imported definitions
  carry an explicit `rufloOnly` marker and are only exposed through Ruflo
  catalog/swarm surfaces.
- No database schema, dependency, Git history, commit, or push changes are
  required by this phase.

## Verification

Focused Phase 9 tests are in `test/ruflo-phase9.test.mjs` and cover:

1. registry count, provenance, schemas, and resource metadata;
2. approval and schema enforcement for adapted memory tools;
3. bounded native executor behavior;
4. explicit disabled authority tools;
5. Phase 8 capability registration for an imported agent type;
6. Normal Agent isolation markers.

Final verification:

- `pnpm --filter @workspace/api-server run test:ruflo-phase9` — **6 passed, 0 failed**.
- `pnpm --filter @workspace/api-server run test:ruflo-all` — **64 passed, 0 failed**
  across the existing Ruflo workflow/MCP/live/Phase 6/Phase 8 suites and Phase 9.
- `pnpm --filter @workspace/api-server run test:full` — **148 passed, 0 failed**.
- `pnpm run typecheck` — passed for libraries, API server, Cosmic Agent,
  mockup sandbox, and scripts.
- `pnpm --filter @workspace/api-server run build` — passed.
- `git diff --check` — passed.
- `artifacts/api-server: API Server` restarted successfully and reported
  `Server listening` on port 8080 with no startup errors.

## Remaining gaps

This phase does not claim feature-for-feature parity with the original Ruflo.
Remaining gaps are the intentionally excluded distributed/runtime surfaces
listed above, plus the original catalog's larger set of native tools,
commands, skills, and agent prompt files that cannot be safely or meaningfully
executed by the current bounded server.