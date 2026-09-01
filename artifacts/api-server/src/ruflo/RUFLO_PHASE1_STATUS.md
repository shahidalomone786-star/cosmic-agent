# Ruflo Phase 1 Status

## Implemented

- Workspace paths reject null bytes, encoded and lexical traversal, POSIX/Windows absolute paths, protected files, and binary text targets.
- Workspace reads follow only paths whose realpaths remain inside the canonical workspace.
- Workspace writes, directory creation, deletion, and rename validate existing ancestors and final targets immediately before filesystem operations.
- Proposal application, rollback, undo, validation re-checks, commit, and push replay paths use workspace confinement and approval re-checks.
- Approvals bind to the authenticated user, session, proposal version, repository state, file hashes, task context where present, and exact action.
- Ruflo and Normal Agent proposal registration preserve session ownership; the shared approval route retrieves Ruflo’s registered session binding.
- Added a Ruflo-owned dynamic DAG scheduler with:
  - duplicate, missing-dependency, invalid-role, task-count, and cycle validation;
  - dynamic task insertion with session ownership checks;
  - bounded concurrency, task/session runtime, tool-call, retry, and total-task limits;
  - deterministic read/read sharing and read/write/write exclusion;
  - lock cleanup on completion, failure, timeout, and cancellation;
  - dependent-task blocking and independent-task failure isolation;
  - stale workspace revision and overlapping read/write or write/write conflict detection;
  - structured aggregation of task results and conflicts.
- Added focused approval, workspace traversal/symlink, DAG scheduling, timeout/retry, locking, dependency, failure-isolation, conflict, and replay-boundary tests.

## Approval boundary preserved

`Planner → DAG → Agents → Review → ChangeProposal → User Approval → Apply → Validate → Git Review → User Approval → Commit → User Approval → Push`

The scheduler only executes bounded Ruflo task operations and aggregates results. It does not apply files or perform Git writes. Existing sequential Ruflo preparation and post-approval behavior remains the safe default.

## Checks run

- `pnpm --filter @workspace/api-server run test` — **79 passed, 0 failed**
- `pnpm --filter @workspace/api-server run typecheck` — **passed**
- `pnpm --filter @workspace/api-server run build` — **passed**
- Restarted `artifacts/api-server: API Server`; workflow reported `Server listening` on port 8080.

## Database changes

None. The existing Ruflo session/task/activity tables were not changed. The dynamic scheduler currently keeps its full task graph and lock state in memory; durable DAG persistence can be added only with an explicit schema/API decision.

## Known limitations

- The dynamic scheduler is an explicit Ruflo orchestration layer. The existing route-driven sequential coordinator remains the default fallback and is not silently replaced.
- Scheduler operations receive bounded cancellation signals, but an operation must cooperate with its signal for underlying provider work to stop immediately.
- Approval state remains process-local, consistent with the existing approval infrastructure.

## Normal Agent isolation

Normal Agent runtime behavior was not changed. It uses the same shared approval and proposal executor with backward-compatible optional session context, so the strengthened ownership and filesystem checks apply without adding Ruflo scheduling or changing its orchestration.