# RUFLO Phase 10 Status

Date: 2026-09-04

## Scope

Phase 10 adapts the audited MIT Ruflo source surface through the existing
server-owned Ruflo registry and executor. It does not copy the original
runtime wholesale, create a second registry, change Git history, or grant
Normal Agent access.

Audited source:

- Repository: `https://github.com/ruvnet/ruflo`
- Revision: `db4991967c45c6f72133dff0bb80b0a492960fc1`
- License: MIT

## Verified inventory

The source audit found:

- **277** original lower-case tool declarations from the audited primary MCP
  tool surface.
- **91** additional MIT plugin declarations adapted from quality engineering,
  performance, code intelligence, coordination, graph, cognitive, legal,
  financial, healthcare, Prime Radiant, Teammate, and Gastown source modules.
- **78** source declarations retained as disabled metadata because the
  required authority or infrastructure is not available.
- **6** Phase 9 identifiers are recognized as duplicates and remain represented
  by their existing canonical definitions.

The unified registry was then measured directly:

- **378** registered Ruflo tool identifiers.
- **300** enabled and executable Ruflo tools.
- **78** disabled Ruflo tool identifiers.

The enabled count includes the existing Phase 8/9 server-owned tools, 284
unique Phase 10 adapted source definitions, and five read-only Phase 10
inventory/security control tools. A tool counts as executable only when it is
registered, enabled, schema-validated, permission-checked, bounded by resource
limits, routed to an implementation, and covered by an audit record.

Every Phase 10 source definition records:

- original source path and exact audited revision;
- MIT license and original tool name;
- adaptation versus disabled metadata status;
- input/output schema;
- permissions, risk, approval requirement, agent access, timeout, and
  resource limits.

## Execution adapters

### Bounded evidence adapter

Safe source tools use the existing repository and workspace readers/searchers.
They return bounded, source-linked evidence rather than pretending to provide
the original Ruflo authority runtime. Output is normalized through the existing
bounded result path and remains Ruflo-only.

### Sandboxed terminal adapter

The original unrestricted shell contract remains disabled. Phase 10 provides a
fixed-command server-owned adapter with:

- `shell: false`;
- a fixed command allowlist: `pwd`, `ls`, `rg`, `git`, and `pnpm`;
- read-only Git commands only;
- `pnpm` restricted to version/typecheck/build validation;
- workspace-root execution;
- sanitized environment;
- bounded arguments, output, timeout, and history;
- explicit approval and audit records.

### Public browser-lite adapter

Only the following public HTTPS operations are enabled: open, snapshot/text,
title, URL, wait, safe session listing, reload, back, forward, and close.
Browser actions such as click/fill/eval, cookies, screenshots, arbitrary
navigation, and session replay remain disabled.

The enabled adapter enforces:

- HTTPS only;
- no credentials or non-443 ports;
- DNS resolution before fetch;
- loopback, private, link-local, reserved, `.local`, and `.internal` blocking;
- redirects blocked unless the final URL is explicitly validated;
- text/HTML content only;
- bounded body/text output and basic secret-pattern redaction.

## Deliberately disabled surfaces

The following source capabilities remain disabled and are not counted as
executable:

- unrestricted browser actions, cookies, evaluation, and arbitrary navigation;
- cross-machine federation;
- original WASM agents and gallery/local runtime;
- transfer, marketplace, IPFS, and external plugin operations;
- arbitrary HTTP fetch;
- unsupported claim persistence mutations;
- second hive-mind authority mutations;
- native agent spawning/execution/termination/update.

These are explicit registry definitions with provenance and reasons. They do
not silently fall through to the bounded evidence adapter.

## Security and isolation

- All execution routes through `createDefaultRufloToolRegistry()` and
  `createRufloToolExecutor()`.
- Authorization checks enabled state, declared permissions, JSON schema, risk,
  and approval.
- Tool execution writes authorized/completed/failed audit records.
- Phase 8 swarm identity/capability boundaries remain the only agent
  coordination authority.
- Normal Agent capability exposure remains unchanged and does not include
  Phase 10 tools or imported agent types.
- Workspace traversal, encoded traversal, absolute paths, symlink escapes,
  private-network browser targets, shell injection, oversized output, and
  process execution outside the allowlist have focused regression coverage.

## Verification

Passing checks:

- Phase 10 focused suite: **5 passed, 0 failed**.
- Phase 9 regression suite: **6 passed, 0 failed**.
- Aggregate Ruflo suite, now including Phase 10: all suites passed.
- Full API suite: **153 passed, 0 failed**.
- API TypeScript typecheck: passed.
- API build: passed.
- LSP diagnostics: no diagnostics.
- `git diff --check`: passed.
- Managed API workflow restarted successfully; server logged `Server listening`
  on port `8080`. All three configured workflows were running at verification.

Phase 10 focused coverage includes:

- 300-plus inventory and metadata completeness;
- disabled authority surfaces;
- bounded adapter execution and serialization;
- audit trace creation;
- fixed-command terminal execution and rejection of shell commands;
- private-network SSRF rejection.

## Security scan findings

The required dependency, SAST, and HoundDog scans completed:

- Dependency audit: **0 critical, 7 high, 2 moderate, 2 low, 0 info**.
  Reported packages include `brace-expansion@5.0.8` (fix `5.0.9`),
  `fast-uri@3.1.4` (fix `3.1.5`/`3.1.6`), `js-yaml@4.3.0` (fix `4.3.1`),
  `esbuild@0.27.3` (fix `0.28.1`), `nanoid@3.3.16` (fix `3.3.18`), and
  `qs@6.15.3` (fix `6.16.0`).
- SAST: high-severity path-construction heuristics in the existing bounded
  workspace helper. The workspace-specific traversal and symlink tests passed;
  this Phase 10 change did not weaken those guards or modify that helper.
- HoundDog: **0 findings**.

Dependency remediation and unrelated workspace-helper refactoring were not
included in Phase 10. The findings above are reported rather than hidden.

## Change boundary

No commits, pushes, or Git history changes were made.