---
name: Phase 12 orchestration boundary
description: Durable design rule for the Ruflo intelligence and production orchestration layer.
---

Phase 12 is an adapter/control layer over the existing Ruflo runtime. It must
reuse the existing model planner, dynamic DAG scheduler, authenticated swarm
and agent capabilities, canonical tool registry, provider router, memory
store, live events, session activity persistence, and Cosmic proposal/approval
workflow rather than creating parallel infrastructure.

**Why:** Parallel schedulers, registries, memories, or approval paths would
split authority and make compatibility claims unsafe. The existing
`proposal → approval → snapshot validation → apply → commit → push` sequence
is the trusted mutation boundary.

**How to apply:** Add new Phase 12 contracts as bounded validation, state
projection, diagnostics, checkpoint, lease, and metrics adapters. Preserve
disabled/metadata-only classifications and fail closed for autonomous
mutation, self-approval, unrestricted execution, and unsupported Ruflo
authority surfaces.