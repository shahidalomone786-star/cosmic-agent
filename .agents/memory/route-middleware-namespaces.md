---
name: Route middleware namespaces
description: Router-level middleware in the API must pass through unrelated mounted paths.
---

Router-level guards run before later routers, so an auth guard must first check its own route namespace (for example `/ai/` or `/repository/`) before rejecting unauthenticated requests.

**Why:** A broad guard on an earlier mounted router intercepted authentication and settings endpoints and made every request appear unauthorized.

**How to apply:** Scope each router-level middleware to the router's path prefix, or attach guards directly to protected route handlers.