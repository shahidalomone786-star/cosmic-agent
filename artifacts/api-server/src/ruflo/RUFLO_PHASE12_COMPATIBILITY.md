# Ruflo Phase 12 Compatibility

Date: 2026-09-06

## Classification rules

This document separates compatibility with the audited Ruflo concepts from
Cosmic-owned implementations. Registry counts and imported metadata are not
treated as proof of behavioral parity.

| Capability | Phase 12 classification | Verified boundary |
|---|---|---|
| Task understanding and planning | Adapted, bounded | Existing `ModelRufloPlanner` supplies the inspected plan; Phase 12 validates interpretation, assumptions, evidence, resources, and approval needs. |
| Repository/workspace context | Cosmic capability reused | Existing authenticated repository/workspace readers and bounded context are the only sources admitted to a Phase 12 plan. |
| Execution DAG | Adapted | `RufloDynamicDagScheduler` remains the scheduler; Phase 12 adds a schema-validated node contract, state projection, retries, cancellation, dependency blocking, and approval waiting. |
| Multi-agent coordination | Adapted | Existing Phase 8 authenticated swarm/agent boundaries are reused; Phase 12 adds independent role capabilities, tool allowlists, leases, heartbeats, and cancellation ownership. |
| Native Ruflo worker lifecycle | Partial / not claimed | Phase 12 does not claim original worker-process, hook-ordering, or unrestricted spawn parity. |
| Memory and RAG | Adapted / scoped | Existing project memory retrieval is reused. Phase 12 experience records add exact user/project/workspace/session scope and bounded provenance, confidence, and expiry metadata. |
| SONA / ReasoningBank / AgentDB parity | Not verified | Phase 12 does not relabel bounded learning suggestions as original Ruflo cognitive-memory parity. |
| Recovery and retries | Adapted | Existing jobs and post-approval workflow recovery are reused; Phase 12 classifies failures and stops automatically on validation, authorization, capability, and workspace failures. |
| Checkpoint and resume | Adapted | Checkpoints are bounded and owner/session/project/approval-version bound. Durable records use the existing Ruflo session activity store; resume always revalidates bindings. |
| Provider/model routing | Cosmic capability reused | Existing capability-aware provider router, fallback policy, cost limits, and failure classifications remain authoritative. Phase 12 records bounded provider traces only. |
| Tool routing | Cosmic capability reused | Existing canonical registry, schemas, permissions, implementation classifications, resource limits, audit, and Ruflo-only access remain authoritative. Disabled and metadata-only tools are never promoted by Phase 12. |
| Proposal and Cosmic approval | Cosmic-native boundary | Phase 12 may prepare a proposal, but apply, commit, push, and approval remain separate server-owned operations. |
| Observability | Adapted | Existing live events, activity records, audit records, request/session/user correlation, redaction, and bounded Phase 12 metrics/diagnostics are reused. |
| Normal Agent isolation | Cosmic-native guard | Normal Agent does not receive Ruflo planner/swarm/orchestration/spawn authority, and server-side name guards reject bypass attempts. |
| Browser automation, federation, WASM, marketplace/IPFS | Disabled | No Phase 12 path enables these authority-heavy or unrestricted source capabilities. |
| Autonomous repository mutation or self-approval | Disabled | No Phase 12 path can apply, commit, push, or approve without the existing Cosmic workflow and exact approval binding. |

## Compatibility limitations

The Phase 12 layer is intentionally not a wholesale Ruflo runtime port. It
does not claim:

- original hook, CLI, skill, plugin, worker, or process semantics;
- unrestricted network, shell, browser, JavaScript, credential, or cookie access;
- cross-machine federation or marketplace/plugin installation;
- autonomous code mutation, autonomous approval, or authority transfer;
- full original memory-learning or provider-specific parity.

These limitations are fail-closed classifications, not missing registry
entries. The existing Phase 8–11 reports remain the source of truth for their
inventory and native/adapted/disabled counts.

## Regression evidence

Phase 12 focused coverage verifies plan validation, recursive and cycle
rejection, bounded DAG execution, retry and dependency blocking, cancellation,
approval waiting, tool classification, failure diagnosis and retry policy,
memory/checkpoint isolation, provider traces, leases/heartbeats, authority
gating, and Normal Agent authority-name rejection. Existing Phase 8–11 and
full API regressions remained green at the reporting checkpoint.