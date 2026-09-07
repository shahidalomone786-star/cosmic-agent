---
name: Patched dependency availability
description: Security dependency upgrades must be checked against the Replit package registry before pinning.
---

When a security scanner reports a fixed dependency version, verify that the
workspace package registry actually serves that version before adding an
override or lockfile pin.

**Why:** The available registry can lag the scanner’s advisory data. An
unresolvable override can break every install and is worse than an explicitly
tracked residual finding.

**How to apply:** Upgrade versions that resolve and install successfully;
document unavailable fixes as remaining findings and revisit when the registry
publishes them.