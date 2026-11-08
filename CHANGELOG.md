# Changelog

All notable changes to `@agentry/api` are recorded here.
Detailed write-ups live under [`docs/changes/`](docs/changes/).

## 2026-11-08 — Postgres store

- Agents, environment templates, environments, and a session index live in Postgres (`Store`, `src/store/`); numbered forward-only migrations run at startup under an advisory lock. The JSON-file `durable-store.ts` is removed.
- Every `/v1` route is owner-scoped: another owner's record answers 404. `/v1` answers 503 `store_unavailable` while the store opens, after it failed to start (`StoreStartError` logged), and when a database call fails.
- Environment routes go through `EnvironmentProvider`; local environments live at `<workspaces>/<owner>/<environment_id>/` and default session workspaces at `<workspaces>/<owner>/<session_id>/`.
- Breaking: `database.url` is required (`AGENTRY_DATABASE_URL` in the bundled patch); `dataDir` and Codebox settings are rejected at load (`CodeboxDisabledError`). `GET /agents/sessions` is newest first and ignores `order`.
- See [docs/changes/2026-11-08-postgres-store.md](docs/changes/2026-11-08-postgres-store.md).

## 2026-11-08 — Keycloak authentication

- Replaced the single `apiKey` with an `auth` block: `production` verifies Keycloak JWTs (issuer, audience, JWKS), `development` accepts a fixed `devKey`. Owner is the token `sub`; roles come from `realm_access.roles`.
- 401 responses carry code `unauthenticated` and `WWW-Authenticate: Bearer`; 403 uses `forbidden`. The gateway passes the `Principal` to every route handler; owner filtering follows with the store.
- Breaking: `apiKey` is removed; `cordis.patch.yml` reads the development key from `AGENTRY_DEV_KEY`.
- See [docs/changes/2026-11-08-keycloak-auth.md](docs/changes/2026-11-08-keycloak-auth.md).

## 2026-11-08 — Standalone build

- Renamed the package to `@agentry/api` (was `@deepseek-ai/dsh-experimental-agents-api` / `@fakhrulfaiz/dsh-agents-api`).
- Standalone build against a pinned DSH tag: `dsh.pin`, `DSH_ROOT`, `pnpm check:dsh-pin`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Entry is the built `lib/index.js`; the tsx-only `src/entry.js` is removed.
- `typecheck`, `test`, and `build` run the pin check (also rejects tracked-file changes); `dsh:link` fails when DSH declarations are missing; DSH peer ranges are `>=0.2.2-rc.1`.
- Carried over the parked function-tools note: [docs/changes/2026-09-18-agents-api-parked-function-tools.md](docs/changes/2026-09-18-agents-api-parked-function-tools.md).

## 2026-09-18 — Agent changelog rule

- Add `AGENTS.md` and `.cursor/rules/changelog.mdc` so every shipped change updates `CHANGELOG.md` and `docs/changes/`.
- See [docs/changes/2026-09-18-agent-changelog-rule.md](docs/changes/2026-09-18-agent-changelog-rule.md).

## 2026-09-18 — Mount wire function tools

- Mount `agent.tools` entries of `type: "function"` as scoped Host tools.
- Park Host `execute` until the client posts `agent.session.input.tool_result` (legacy `function_call_output` accepted).
- Emit `agent.session.requires_action` and populate `required_actions`.
- Reject MCP / web_search / deferred function tools at create time.
- See [docs/changes/2026-09-18-mount-function-tools.md](docs/changes/2026-09-18-mount-function-tools.md).
