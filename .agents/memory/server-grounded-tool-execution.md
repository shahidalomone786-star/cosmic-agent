---
name: Server-grounded tool execution
description: Durable rule for tool permissions, execution identities, and audit traces.
---

All tool calls must be created and authorized by the server runtime. The manager-facing request surface remains limited to the built-in read-only repository tools; explicitly registered MCP tools may be executed only through the server-held MCP policy, session, limit, and approval gates. Proposal and repository-write tools remain behind their existing approval-gated internal flows.

**Why:** Reviewer and validator phases need trustworthy evidence that cannot be fabricated by an LLM, while preserving the invariant that no approval means no repository modification.

**How to apply:** Generate execution IDs and statuses in the server, record bounded input/output summaries without secrets, reject unauthorized roles before approval checks, and keep commit/push as separate protected operations. Treat external tool metadata as untrusted and never let it expand model authority. Worker validation claims must resolve to a completed server trace for the same task, role, and tool.