---
name: GitHub repository errors
description: Durable constraints for the read-only GitHub repository provider.
---

The repository provider must validate the repository endpoint before touching branches, files, or trees, resolve the selected branch to a Git SHA, and preserve endpoint-specific errors through the API boundary.

**Why:** GitHub uses overlapping HTTP statuses for repository, ref, file, permission, and rate-limit failures. Collapsing them into one 404-style message makes valid public repositories appear broken and prevents useful recovery.

**How to apply:** Keep credentials server-side and optional for public access; classify rate limits, missing resources, invalid URLs, and service failures separately; treat recursive tree responses as `{ tree: [...] }`, not as bare arrays. Live validation from a shared runner may hit the unauthenticated GitHub limit, which must remain `rate_limited`, not `not_connected`.