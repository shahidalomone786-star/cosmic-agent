---
name: Phase 9 import boundaries
description: Safe reuse rules for adapting the audited Ruflo catalog into Cosmic Agent.
---

Only adapt original Ruflo capabilities when they can execute through Cosmic Agent's existing server-owned registry, workspace/memory stores, audit log, approvals, and Phase 8 authenticated swarm service. Keep arbitrary terminal/browser/federation/WASM/local-runtime/marketplace authority as disabled metadata until a dedicated bounded service exists.

**Why:** The original Ruflo catalog is broader than the current product's trust boundary; copying its runtime or granting its names directly would bypass established approval, SSRF, workspace, and agent-isolation controls.

**How to apply:** Preserve original revision/source/license provenance on adapted metadata, mark imported surfaces Ruflo-only, and report source-tree counts separately from enabled adapter counts.