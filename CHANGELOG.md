# Changelog

All notable changes to `@agentry/api` are recorded here.
Detailed write-ups live under [`docs/changes/`](docs/changes/).

## 2026-11-08 — History from the Session log, restart recovery, SSE replay

- Items, turns, and `GET .../events` replay are derived from the DSH Session log (`dsh-session-query`) instead of memory, so they survive restarts. Live and replay share one projector (`WireProjector`): turn ids are `turn_<log position>`, event ids are `evt_<session>_<n>`, and each frame's SSE `id:` is its position in the derived sequence. `Last-Event-ID` replays exactly the missed events, then continues live.
- Status snapshots on connect, the idle event of a streamed create without input, and dispatch `error` events are ephemeral: no `id:`, never replayed.
- Startup recovery: sessions that were `in_progress` or `requires_action` are resumed through `ctx.agents.resume`, or marked `interrupted` with `last_error`. A POST to a session that is not live resumes it lazily. The session status is written to the index wherever its wire event is produced, so `listResumable` is accurate.
- Migration `0002` adds `sessions.body jsonb`: the session's resolved agent, environment, metadata, and vault ids, needed to rebuild the agent on resume. Recovery is skipped (warning, rows untouched) when the agent factory is not registered yet. Rows created before it cannot be resumed (409 `session_not_resumable`; interrupted at startup).
- Cancel reports `agent.session.turn.cancelled` when the Host ends the turn. An open turn at a crash becomes `cancelled` with `error.code: "interrupted"`.
- Fixes: `GET /agents/sessions` is built from index rows only (`has_more` and `last_id` agree with `data`); `workspaces` is required by the gateway (no host-cwd fallback); `POST /agents/sessions/{id}` answers 404 when the session row is gone.
- Breaking: the profile must provide `sessionQuery` and `sessionPersistence`; peer dependencies `dsh-session-query` and `dsh-session-persistence` added.
- See [docs/changes/2026-11-08-durable-history.md](docs/changes/2026-11-08-durable-history.md).

## 2026-11-08 — apiKeys auth mode

- New `auth.mode: apiKeys` for simple self-hosting: named keys (`agk_` + 43 base64url characters) in `auth.apiKeys`, stored as `sha256:` hashes; with `auth.keycloak` also set, either credential works. `pnpm keys:create --name <n> --owner <o> [--admin]` prints a key once and its config entry.
- `production` rejects `apiKeys` entries and `devKey`; `development` rejects `apiKeys`.
- Breaking: `workspaces` is required (the OS temp-dir fallback and the `AGENTS_API_WORKSPACES` env var are removed); the bundled patch reads `AGENTRY_WORKSPACES`.
- Fix: `POST /agents/sessions/{id}` writes the session index before changing the live session, so a store failure answers 503 and leaves the session unchanged.
- See [docs/changes/2026-11-08-api-keys-mode.md](docs/changes/2026-11-08-api-keys-mode.md).

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
