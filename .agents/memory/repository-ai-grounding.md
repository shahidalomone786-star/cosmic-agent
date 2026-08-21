---
name: Repository AI grounding
description: Repository answers must fail closed when source retrieval is unavailable.
---

Repository-aware AI must receive indexed metadata and source excerpts, and must explicitly say when repository evidence cannot be retrieved rather than infer framework, auth, or architecture details.

**Why:** Public GitHub API rate limits can clear the in-memory index between workflow restarts; silently dropping context caused the model to invent an architecture.

**How to apply:** Preserve the explicit grounding instruction and unavailable-evidence fallback whenever repository context retrieval changes.