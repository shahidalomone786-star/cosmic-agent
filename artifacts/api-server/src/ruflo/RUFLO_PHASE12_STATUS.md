# Ruflo Phase 12 Status

Date: 2026-09-06

## Scope

Phase 12 adds a bounded intelligence and orchestration contract around the
existing Ruflo runtime. It extends the existing model planner, unified tool
registry, dynamic DAG scheduler, provider router, memory store, live-event hub,
session activity store, swarm capability model, and proposal workflow. It does
not create a second swarm, job manager, registry, memory system, approval
system, or router.

The authority boundary remains:

`proposal → approval → snapshot validation → apply → commit → push`

Phase 12 agents can inspect, reason over bounded evidence, validate, coordinate,
retry safe work, checkpoint, resume after revalidation, and prepare proposals.
They cannot apply repository changes, commit, push, or approve their own work.

## Implemented contract

`src/ruflo/ruflo-phase12.ts` provides:

- Schema-shaped, bounded plan objects containing interpretation, assumptions,
  capabilities, agents, tools, DAG dependencies, outputs, risk, approval
  needs, budgets, recovery policy, and evidence.
- Plan validation with node, agent, tool, input, output, timeout, retry, and
  resource limits.
- Recursive/unbounded instruction rejection and cycle/missing-dependency
  rejection before scheduling.
- Explicit Phase 12 agent identities, independent capabilities, allowed tools,
  leases, heartbeat renewal, cancellation ownership, and bounded agent count.
- A Phase 12 DAG adapter over `RufloDynamicDagScheduler` with READY, RUNNING,
  RETRYING, SUCCEEDED, FAILED, BLOCKED, CANCELLED, and WAITING_APPROVAL
  projections.
- Retry classification that never retries validation, authorization,
  capability, or workspace failures automatically.
- Structured diagnostics with correlation fields, bounded evidence, and the
  literal insufficient-evidence root-cause message when proof is unavailable.
- Provider-attempt traces that preserve the existing router's selected model,
  fallback, reason, and failure classification without exposing credentials.
- User/project/workspace/session memory scope and provenance/confidence/expiry
  fields for bounded learning suggestions. These suggestions cannot change
  permissions, approval state, tool availability, or routing authority.
- In-memory checkpoint behavior for focused tests and an activity-backed
  `Phase12CheckpointStore` adapter that reuses the existing authenticated
  Ruflo session persistence. Resume checks revalidate owner, project, session,
  and approval-version bindings.
- An explicit authority assertion that rejects apply, commit, push, and approve
  actions outside the existing Cosmic-controlled workflow.

## API surface

After an authenticated Ruflo session has completed its bounded inspection,
Cosmic exposes:

`GET /ruflo/sessions/:sessionId/phase12/plan`

The endpoint is owner-bound, refuses sessions that have not produced bounded
repository/workspace evidence, uses the server-owned canonical registry, and
records plan creation in the existing session activity stream.

## Normal Agent isolation

Normal Agent tool execution now rejects server-side names for Ruflo, swarm,
planner, orchestration, agent spawning/execution, federation, hive-mind, and
MCP authority surfaces. Ruflo-only tools remain behind the authenticated Ruflo
router and registry. This is a server check and does not depend on a client
mode or role field.

## Verification

Verified at the reporting checkpoint:

- Phase 12 focused suite: **8 passed, 0 failed**.
- Aggregate Ruflo suites for Phases 6, 8, 9, 10, 11, and 12: **all passed**.
- Full API suite: **167 passed, 0 failed**.
- API TypeScript typecheck: passed.
- API build: passed.
- Cosmic frontend typecheck: passed.
- Cosmic frontend build: passed. Vite emitted an existing sourcemap warning
  for `src/components/ui/tooltip.tsx` but completed successfully.
- LSP diagnostics: no diagnostics.
- `git diff --check`: passed.
- Managed API workflow restarted successfully and logged `Server listening` on
  port `8080`; all three configured workflows were running.

## Security scan

Fresh scans completed:

- Dependency audit: **0 critical, 7 high, 2 moderate, 2 low, 0 info**.
- SAST: existing high-severity path-construction heuristics in
  `src/preview-runtime.ts` and `src/workspace/local-workspace.ts`. Existing
  traversal, encoded traversal, absolute-path, symlink, and workspace-boundary
  regression tests passed. Phase 12 did not modify those helpers.
- HoundDog: **0 findings**.

## Change boundary

- Database schema/migrations: **NONE**. Phase 12 reuses the existing session
  activity persistence for checkpoint records.
- Phase 13, autonomous authority, unrestricted shell/browser/network access,
  federation, WASM, marketplace/IPFS, autonomous repository mutation, and
  self-approval: **NOT IMPLEMENTED**.
- Git commits, pushes, resets, rebases, and history rewrites: **NONE**.