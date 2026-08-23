---
name: Manager plan compatibility
description: Why the manager orchestration plan is kept separate from the legacy runtime progress plan.
---

The canonical manager plan and the existing seven-step runtime progress display are separate models.

**Why:** The earlier runtime and UI already depend on lowercase progress statuses and step IDs for proposal and approval behavior. Replacing that model would risk Phase 4–11 regressions, while the new manager needs uppercase bounded orchestration statuses and richer dependency metadata.

**How to apply:** Add manager orchestration state alongside the legacy session progress state until a later integration pass deliberately migrates the UI and runtime together.