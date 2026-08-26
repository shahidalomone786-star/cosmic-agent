---
name: Protected GitHub credential context
description: Environment-specific behavior when using a stored GitHub credential for repository operations
---

Use the protected API/execution context for GitHub operations that depend on a stored credential; a shell process may expose a different or unusable credential context even when the protected API call succeeds.

**Why:** Repository identity lookup succeeded through protected execution while an equivalent shell Git operation rejected its inherited credential.

**How to apply:** Do not conclude the credential is invalid from a shell-only Git failure. Keep the credential inside protected execution and never print, persist, or place it in repository files.