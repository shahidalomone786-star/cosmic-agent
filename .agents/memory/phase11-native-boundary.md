---
name: Phase 11 native boundary
description: Keep native Ruflo registry introspection lightweight while injecting heavy repository and workspace readers only at runtime.
---

Native registry definitions must remain import-light; repository/workspace and
database-backed readers are injected by the runtime execution boundary rather
than imported by the registry/catalog module.

**Why:** Bundling the registry for focused tests or metadata consumers should
not pull PostgreSQL and filesystem runtime dependencies into an ESM
registry-only bundle.

**How to apply:** Add new native handlers as pure definitions plus injected
reader interfaces, and keep server-owned authorization, limits, and audit in
the runtime executor.