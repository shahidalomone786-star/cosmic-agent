# Ruflo Phase 3 Status

## Scope delivered

Phase 3 adds Ruflo-only multi-provider routing, capability selection, bounded fallback, failure classification, and token/cost budget enforcement without changing Normal Agent routing.

### Supported provider scope

The current architecture has two concrete providers, and Phase 3 reuses them:

- Gemini
- Groq

Provider discovery uses the existing provider manager, health checks, approved model registry, and configured model availability. OpenAI, Anthropic, Cohere, and Ollama were not present as concrete providers in this codebase, so no duplicate or unsupported clients were added.

### Ruflo routing

- Supports `light`, `medium`, and `heavy` capability classes.
- Infers a capability from the task text when the caller does not supply one.
- Selects a compatible model using capability, model strength, recommendation, cost tier, health, configuration, and context-window checks.
- Provides bounded compatible fallbacks.
- Keeps the routing gateway isolated to Ruflo calls.
- Exposes safe provider/model availability and per-session routing metadata without exposing credentials.

### Failure and fallback behavior

Ruflo provider failures are classified as:

- timeout
- rate limit
- authentication/configuration
- unavailable
- context limit
- budget limit
- unknown

Retries and fallback attempts are bounded by the Ruflo budget configuration. Context incompatibility is rejected before a provider request. Existing Ruflo runtime iteration, tool-call, approval, workspace-safety, DAG, lock/conflict, rollback, and recovery boundaries remain in place.

### Token and cost control

- Uses provider usage metadata when returned by Gemini or Groq.
- Falls back to bounded character-based token estimation when exact usage is unavailable.
- Tracks input, output, total tokens, request counts, and provider/model breakdowns per Ruflo session.
- Calculates cost when pricing is supplied.
- Reports `unknown` cost instead of fabricating prices when pricing is unavailable.
- Enforces input-token, output-token, session-token, session-cost, request-cost, and provider-retry limits.
- Limits can be configured with `RUFLO_MAX_*` environment variables and lowered per request; a request cannot raise an environment-configured ceiling.

Current tracking is process-local and session-scoped. No database schema change was made because the existing Phase 3 requirement can be met without changing the established session/task/activity schema.

## API additions

- `GET /api/ruflo/providers`
  - Returns safe provider health, configured model availability, capability classes, context windows, and cost tiers.
- `POST /api/ruflo/sessions`
  - Accepts optional `capability`, `model`, and bounded `budget` settings.
  - Uses the Ruflo provider gateway for planner, proposal, fixer, and validation-provider calls.
- Ruflo session responses include capability, selected route/fallback metadata, and usage totals.

## Files

- `src/ai/ai-provider.ts`, `src/ai/gemini-provider.ts`, `src/ai/groq-provider.ts`
  - Optional output-token requests and provider usage metadata.
- `src/ai/model-registry.ts`, `src/ai/provider-manager.ts`
  - Capability/cost metadata and provider discovery access.
- `src/ruflo/ruflo-provider-router.ts`
  - Ruflo model discovery, routing, gateway fallback, and failure classification.
- `src/ruflo/ruflo-cost-tracker.ts`
  - Ruflo token/cost accounting and hard budget enforcement.
- `src/ruflo/ruflo-runtime.ts`, `src/routes/ruflo.ts`
  - Gateway integration while preserving existing Ruflo safety/recovery flow.
- `test/ruflo-provider-router.test.mjs`, `test/ruflo-cost-tracker.test.mjs`
  - Focused Phase 3 coverage; the API test script bundles these modules.

## Verification completed

Run on September 1, 2026:

- API tests: **97 passed, 0 failed**
- Workspace library typecheck: passed
- API server typecheck: passed
- API server build: passed
- Managed API workflow restart: passed
- Live API health check: `GET /api/healthz` returned HTTP 200

## Deliberate exclusions

No MCP, SSE, browser agents, workers, Git intelligence, premium UI, marketplace/plugin features, commits, pushes, unsupported provider clients, or Normal Agent routing changes were added.