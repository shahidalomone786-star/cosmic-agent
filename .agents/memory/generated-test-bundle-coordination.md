---
name: Generated test bundle coordination
description: The API package's Node tests import generated files from test-dist and must build those entrypoints together.
---

Test commands that import generated JavaScript from `test-dist` must build every required entrypoint in the same runner. Do not run bundle-producing test scripts concurrently when they share and clean that directory.

**Why:** Separate Phase 5 and Phase 6 focused commands can race over a shared generated-test directory, while the legacy aggregate runner may not build every imported entrypoint.

**How to apply:** Keep a dedicated sequential Ruflo aggregate command, and include any new generated test entrypoint in its build step before invoking Node's test runner.