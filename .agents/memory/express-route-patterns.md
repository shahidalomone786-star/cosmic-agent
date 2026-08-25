---
name: Express route patterns
description: Express 5 uses path-to-regexp v8, whose wildcard syntax differs from Express 4.
---

Use mounted middleware for catch-all subpaths instead of an unnamed `*` route pattern in Express 5.

**Why:** An unnamed wildcard causes the API process to fail during router initialization rather than returning a request-time error.

**How to apply:** Prefer `router.use("/prefix/:id", handler)` after specific routes when proxying arbitrary nested paths.