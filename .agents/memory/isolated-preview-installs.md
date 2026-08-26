---
name: Isolated preview installs
description: How generated package-based previews avoid monorepo resolution and non-interactive pnpm failures
---

Generated package-based previews run from an isolated workspace nested inside the monorepo, so dependency installation must explicitly ignore the parent workspace and use pnpm's non-interactive CI mode.

**Why:** Without these flags, pnpm can try to operate recursively across the parent workspace or abort while removing modules because no TTY is available, leaving the generated app unable to resolve its declared dev server.

**How to apply:** Keep lifecycle scripts disabled for generated project installs, use `--ignore-workspace`, and set `CI=true` in the child process environment before starting the server.