---
name: Approval binding
description: Human approval must be a server-held authorization bound to one immutable proposal version.
---

Repository writes require a server-recorded approval bound to the exact proposal, proposal version, repository snapshot, file hashes, task, and approving user.

**Why:** A generic “approved” flag can be replayed against a newer diff or a changed repository and would violate the no-approval/no-modification invariant.

**How to apply:** Record approval separately from proposal generation, verify every binding immediately before patch execution, and reject missing or stale authorization without rebasing.