# RUFLO Phase 11 Status

Date: 2026-09-06

## Scope

Phase 11 adds a narrow native execution slice for the audited Ruflo revision
`db4991967c45c6f72133dff0bb80b0a492960fc1`, while preserving the Phase 8–10
server-owned security boundary:

`proposal → approval → snapshot validation → apply → commit → push`

The phase does not copy the original runtime wholesale and does not enable
unrestricted shell/process spawning, browser automation, JavaScript evaluation,
credential or cookie passthrough, private-network access, arbitrary plugin
loading, WASM/federation/marketplace/IPFS, autonomous repository mutation, or
approval bypass.

## Registry classification

The canonical registry now exposes implementation provenance separately from
original-source provenance:

- `native` — a server-owned handler with a concrete bounded execution path and
  dedicated behavior tests.
- `cosmic-adapter` — real Cosmic execution with materially different semantics
  from the original Ruflo implementation.
- `metadata-only` — source identity or catalog metadata retained without the
  original behavior.
- `disabled` — explicitly fail-closed and not executable.

Direct measurement of the canonical registry at this revision:

| Measure | Count |
|---|---:|
| Registered Ruflo identifiers | 378 |
| Enabled identifiers | 300 |
| Disabled identifiers | 78 |
| `native` | 7 |
| `cosmic-adapter` | 293 |
| `metadata-only` | 38 |
| `disabled` | 40 |
| Native entries with verified Phase 11 tests | 7 |

The classification totals are not additive with enabled/disabled: a
`metadata-only` entry may remain disabled, and implementation kind describes
what the entry is, not whether it is callable.

## Native handlers

The following original read-only tool behaviors now have explicit native,
server-owned handlers:

- `system_status`
- `system_metrics`
- `system_health`
- `system_info`
- `mcp_status`
- `task_summary`
- `workflow_validate`

The native handlers preserve the useful original result shapes where safe,
replace unsafe network/process probes with local bounded checks, and use
Cosmic’s authorized repository/workspace readers for workflow files.

Two evidence-backed Agentic QE declarations also have explicit safe adapters:

- `aqe:detect-secrets`
- `aqe:security-scan`

They scan bounded caller-provided text only, redact matches, and never execute
code or make network requests. They remain `cosmic-adapter` entries because
they do not reproduce the original plugin runtime.

## Execution contract

Every registry entry is normalized with:

- implementation kind and execution mode;
- original source, revision, and behavior reference;
- Cosmic implementation reference;
- risk and test/parity status;
- input/output/resource limits.

Every executor call now has:

- JSON schema and permission/approval enforcement;
- bounded input size, output size, and timeout checks;
- request, agent, job, session, and user correlation fields;
- redacted bounded audit records for authorization, completion, and failure;
- native dispatch separate from generic bounded evidence execution.

## Retained bounded capabilities

The existing runtime remains the execution authority for:

- authenticated swarm identities, mailboxes, blackboard, leases, topology, and
  bounded consensus;
- bounded jobs, retries, cancellation, worker-like specialized agents, and
  post-approval workflow recovery;
- user/project-scoped memory storage and keyword/vector retrieval where the
  configured embedding path is available;
- provider routing, fallback, token/cost budgets, and structured failures;
- fixed-command terminal sandbox and public HTTPS browser-lite;
- proposal, approval, snapshot, Git mutation, and audit controls.

These are classified as Cosmic adapters or Cosmic capabilities, not original
Ruflo behavioral parity.

## Verification

Passing checks:

- Phase 11 focused suite: **6 passed, 0 failed**.
- Aggregate Ruflo suite, including Phases 6, 8, 9, 10, and 11: **all passed**.
- Full API suite: **159 passed, 0 failed**.
- API TypeScript typecheck: passed.
- Native registry bundle and runtime bundle: passed.
- `git diff --check`: passed at the reporting checkpoint.

The Phase 11 suite covers classification, native execution, schema rejection,
resource bounds, correlation/audit fields, disabled authority surfaces, and
workspace/repository requirements for workflow validation.

## Remaining gaps

Phase 11 does not claim full Ruflo parity. Still not verified at original
behavior level are native agent/worker lifecycle semantics, hook ordering,
complete memory/AgentDB/ReasoningBank behavior, full workflow execution,
provider-specific parity, CLI/skill invocation, in-process plugin behavior,
full browser automation, federation, WASM, marketplace/IPFS, and autonomous
authority.

Database changes: **NONE**.

Git commits, pushes, resets, and history rewrites: **NONE**.

## Security scan result

- Dependency audit: **0 critical, 7 high, 2 moderate, 2 low**.
- SAST: existing high-severity path-construction heuristics in the bounded
  workspace/preview helpers; focused traversal and symlink tests pass, and
  Phase 11 did not modify those helpers.
- HoundDog: **0 findings**.