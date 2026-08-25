---
name: Git approval boundary
description: Controlled Git operations use separate server-held approvals for applying, committing, and pushing.
---

The Git lifecycle must keep apply, commit, and push approvals distinct; an approval for one action cannot authorize another.

**Why:** Committing and pushing have different user-visible consequences, and combining them would weaken the existing proposal gate.

**How to apply:** Keep credentials server-side, bind every write to the exact proposal and authenticated user, and make push a non-force fast-forward-only operation.