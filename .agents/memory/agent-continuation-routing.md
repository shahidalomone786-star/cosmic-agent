---
name: Coding request execution route
description: Durable routing rule for keeping repository coding requests on the approval-gated agent path.
---

Repository-backed coding requests must enter the bounded agent session even when the user has not manually selected file chips. The session can retrieve a bounded set of ranked source files and continue to proposal generation; the ordinary chat stream is text-only and has no tool continuation loop.

**Why:** Routing a coding request with no selected paths into ordinary chat allowed the model to describe inspection without any server-authorized next tool call, creating an apparent inspection loop.

**How to apply:** Keep conversational questions on `/api/ai/chat`, but route implementation-intent requests with a connected repository through the agent session. If context retrieval fails, retain the real error in the session and stop safely rather than reporting a successful plan.