---
name: Server-grounded tool execution
description: Durable rule for tool permissions, execution identities, and audit traces.
---

All tool calls must be created and authorized by the server runtime. The manager-facing request surface is limited to read-only repository tools; proposal and write-capable tools remain behind their existing approval-gated internal flows.

**Why:** Reviewer and validator phases need trustworthy evidence that cannot be fabricated by an LLM, while preserving the invariant that no approval means no repository modification.

**How to apply:** Generate execution IDs and statuses in the server, record bounded input/output summaries without secrets, reject unauthorized roles before approval checks, and keep commit/push as separate protected operations. Worker validation claims must resolve to a completed server trace for the same task, role, and tool.