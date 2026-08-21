---
name: Validation runner environment
description: Fixed validation commands must provide frontend build routing variables when invoked outside an artifact workflow.
---

The controlled execution validation runner should preserve the caller environment but supply safe defaults for `PORT` and `BASE_PATH` when they are absent, because Vite production builds require both.

**Why:** Direct smoke tests and server-side execution do not always inherit the managed web workflow environment; without defaults, valid patches are incorrectly rolled back as validation failures.

**How to apply:** Keep validation commands fixed and non-shell-based, and only add missing build-routing variables rather than overriding values supplied by the running artifact.