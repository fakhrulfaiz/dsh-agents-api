# Docs

Package-local reference and change notes for `@agentry/api`.

## Reference

| Page | Summary |
| --- | --- |
| [http-api.md](http-api.md) | Agents API routes, create/stream input, function-tool and approval wire contracts, live model and effort changes |

## Changes

| Note | Summary |
| --- | --- |
| [2026-11-09-openapi-contract.md](changes/2026-11-09-openapi-contract.md) | OpenAPI 3.1 contract with full schemas, `routeTable()`, and the drift and schema-validation tests |
| [2026-11-09-approvals.md](changes/2026-11-09-approvals.md) | Approvals and user questions as `approval` required actions with `approval_response` input; live `model` / `reasoning.effort` updates; create passes the effort |
| [2026-11-08-durable-history.md](changes/2026-11-08-durable-history.md) | Items, turns, and SSE replay derived from the Session log; restart recovery; `sessions.body` (migration 0002); status written to the index |
| [2026-11-08-api-keys-mode.md](changes/2026-11-08-api-keys-mode.md) | `apiKeys` auth mode with hashed named keys and `pnpm keys:create`; `workspaces` required; session update writes the store first |
| [2026-11-08-postgres-store.md](changes/2026-11-08-postgres-store.md) | Agents, templates, environments, and the session index in Postgres with forward-only migrations; owner-scoped routes; local `EnvironmentProvider`; Codebox config rejected |
| [2026-11-08-keycloak-auth.md](changes/2026-11-08-keycloak-auth.md) | `apiKey` replaced by an `auth` block: Keycloak JWT verification in production, a fixed dev key in development |
| [2026-09-23-sandbox-rejected.md](changes/2026-09-23-sandbox-rejected.md) | `environment.type: "sandbox"` is an error; the default environment is a local directory |
| [2026-09-18-agents-api-parked-function-tools.md](changes/2026-09-18-agents-api-parked-function-tools.md) | Parked wire function tools (design note carried over from the DSH checkout) |
