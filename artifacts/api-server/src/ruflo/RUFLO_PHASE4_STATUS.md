# Ruflo Phase 4 Status

## Scope

Phase 4 — Ruflo MCP and secure tool ecosystem only.

## Implemented

- Unified Ruflo tool registry containing the existing built-in read tools and explicitly registered MCP tools.
- Protocol-compatible MCP client with stdio and Streamable HTTP transports.
- Explicit SSE transport rejection.
- Server allowlists, exact tool allowlists, user/project-scoped configurations, and owner-scoped tool IDs.
- MCP schema normalization and input/output validation.
- Permission, risk, disabled-tool, session-ownership, approval, timeout, concurrency, and per-session call-limit enforcement.
- Workspace-relative path protection for path-like MCP inputs.
- Server-held, input-bound approvals for non-read-only and policy-marked tools; approvals are single-use.
- Secret-redacted bounded MCP outputs, errors, and audit records.
- Authenticated Ruflo routes for server configuration, enable/disable, discovery, unified-tool listing, approvals, and execution.
- Ruflo runtime integration with the unified registry while keeping the planner action set limited to the existing built-in read tools.

## Verification

- Focused Phase 4 suite: **19/19 passing**.
- Full API test suite, including Phase 1 security, Phase 2 memory, Phase 3 provider routing/cost behavior, Normal Agent isolation, and Phase 4 MCP coverage: **116/116 passing**.
- API typecheck: **passed**.
- Workspace typecheck: **passed**.
- API build: **passed**.
- Workspace build with managed artifact environment values (`PORT=5173 BASE_PATH=/mockup-sandbox`): **passed**.
- Managed API workflow restart: **passed**; server listening on port 8080 with no startup errors.

The workspace build command without the managed `PORT`/`BASE_PATH` values failed in the mockup artifact before being rerun with those values; the configured-environment build passed.

## Preserved Boundaries

- Normal Agent behavior and its separate execution path were not expanded with MCP authority.
- Existing Ruflo workspace confinement, approval binding, bounded orchestration, memory controls, provider routing, usage tracking, validator boundary, and Git safety boundaries remain covered by the full API suite.
- No database changes were made; Phase 4 configuration, approvals, usage, and audit state remain in memory.

## Explicitly Not Implemented

SSE, browser agents, workers, premium UI, Git intelligence, marketplace/plugin features, commits, pushes, and unrelated Normal Agent changes.

## Changed Files

- `artifacts/api-server/package.json`
- `artifacts/api-server/src/routes/ruflo.ts`
- `artifacts/api-server/src/ruflo/ruflo-runtime.ts`
- `artifacts/api-server/src/ruflo/ruflo-audit.ts`
- `artifacts/api-server/src/ruflo/ruflo-mcp-client.ts`
- `artifacts/api-server/src/ruflo/ruflo-mcp-manager.ts`
- `artifacts/api-server/src/ruflo/ruflo-tool-registry.ts`
- `artifacts/api-server/src/ruflo/RUFLO_PHASE4_STATUS.md`
- `artifacts/api-server/test/ruflo-mcp.test.mjs`