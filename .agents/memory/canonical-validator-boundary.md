---
name: Canonical validator boundary
description: Validation is established only by validator-owned execution traces after an approved patch is applied.
---

The validator must derive pass, fail, or not-verified from completed server-side typecheck/build traces; applying a patch never self-certifies it.

**Why:** Self-reported or reasoning-only validation can falsely unlock commit/push flows and cannot distinguish command failure from infrastructure failure.

**How to apply:** Keep reviewer evidence separate from validator execution, require task/role/tool ownership checks, and roll back plus request a new approved proposal for fail or not-verified outcomes.