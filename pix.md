# COSMIC AGENT

An independent, reusable coding-agent workspace shell for planning software changes with explicit user control.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/cosmic-agent run dev` — run the Cosmic Agent web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/cosmic-agent/src/App.tsx` — Phase 1 workspace shell and simulated interaction states
- `artifacts/cosmic-agent/src/index.css` — Cosmic Agent visual tokens and responsive layout
- `artifacts/cosmic-agent/src/agent/` — agent task, message, plan, and event types
- `artifacts/cosmic-agent/src/providers/` — model provider contract and safe mock provider
- `artifacts/cosmic-agent/src/repository/` — repository provider contract and explicit Phase 1 stub
- `artifacts/cosmic-agent/src/events/` — central event bus for future execution
- `artifacts/cosmic-agent/src/core/` — approval request and decision policy types
- `artifacts/cosmic-agent/src/workspace/` — reusable workspace model
- `artifacts/cosmic-agent/src/tools/` — tool definitions with risk and approval metadata

## Architecture decisions

- The Phase 1 app is frontend-only; repository, model, event, and approval contracts are ready without claiming real execution.
- Providers are capability boundaries: UI code does not own model or repository operations.
- Approval is represented as a first-class request/decision model and is required for future dangerous operations.
- Workspace models contain repository and model context without binding to any product-specific repository or business logic.

## Product

Phase 1 provides a responsive three-pane coding-agent workspace with a task composer, conversation foundation, simulated activity timeline, repository target placeholder, model abstraction, and explicit approval boundary.

## User preferences

- Keep Cosmic Agent independent and reusable; do not hardcode Cosmic Ocean into the agent.

## Gotchas

- Phase 1 activity is simulated UI state only. Do not describe it as a real repository read, edit, command, test, commit, or push.
- Use the artifact workflow for the web app; it supplies `PORT` and `BASE_PATH`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
