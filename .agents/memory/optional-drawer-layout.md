---
name: Optional drawer layout
description: Layout rule for adding optional panels to the Cosmic Agent shell.
---

Optional panels added beside the main workspace must not remain ordinary flex children while closed; desktop panels should be explicitly hidden when closed and mobile panels should use a fixed-position drawer with a contained scroll region.

**Why:** An unstyled or always-mounted panel can consume a workspace column and overflow narrow viewports even when the feature appears visually closed.

**How to apply:** When adding a resource, inspector, or similar panel, define its closed-state layout before wiring the toggle, and include mobile positioning plus overflow rules.