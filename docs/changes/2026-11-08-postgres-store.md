# Postgres store and owner scoping

## What changed

Saved agents, environment templates, environments, and a session index now live in Postgres behind the `Store` interface (`src/store/store.ts`). The JSON-file `durable-store.ts` and the in-memory `AgentStore` and `EnvironmentDirectory` are removed. Items, turns, and steps are not stored in Postgres; the DSH Session log stays their source of truth.

Every `/v1` read and write of these records is scoped to the authenticated owner (`principal.owner`). Another owner's record answers 404, never 403. An owner row is inserted on the owner's first request.

## Schema

`src/store/migrations/0001-initial.sql` creates `owners`, `agents`, `environment_templates`, `environments`, `sessions`, and `admin_audit`, with an `(owner_id, created_at desc)` index on each owner-scoped table and `sessions(status)`. Owned records keep the wire object in `body jsonb`; `environments.provider`, `status`, and `workspace_path` are copied out of `body` in the same statement. Their `created_at` column is the insertion time and orders lists, with `id` as the tie-break.

`migrate(url)` applies files named `NNNN-<slug>.sql` in name order inside one transaction that holds `pg_advisory_xact_lock(hashtext('agentry-migrations'))`, and records each in `schema_migrations(name, applied_at)`. Concurrent starts apply each file once; a failing file rolls the whole run back. Migrations are forward-only: a released file is never edited, and a schema change adds the next number. The build copies the files to `lib/migrations/`.

## Startup and outages

`apply` registers `/health` and `/v1` immediately, then migrates and opens a `pg` pool inside a Cordis effect whose disposer closes the pool. Until the store is open, `/v1` answers 503 `store_unavailable`. When migration or connection fails, the plugin logs a `StoreStartError` and `/v1` keeps answering 503 with that message until the plugin restarts. A store call that rejects during a request answers 503 `store_unavailable`.

## Session index

Session create writes a `sessions` row (owner, saved `agent_id` when given, model, reasoning effort, status `idle`). Session update writes the new model and reasoning effort; session delete removes the row. `GET /agents/sessions` lists the owner's rows newest first and projects the live sessions; `after` continues from a session id and `order` is ignored. `Store.sessions.list` pages with an opaque cursor, base64 of `<created_at ISO>|<id>`, ordered by `created_at desc, id desc`. `listResumable` returns rows of every owner in `in_progress` or `requires_action`. Writing live status changes to the index is not done yet.

## Environments

Environment routes go through `EnvironmentProvider` (`src/environment/provider.ts`). The local provider places each environment at `<workspaces>/<owner>/<environment_id>/`, rejects owner and environment ids that are not single path segments, and rejects file paths that escape the workspace, including through symbolic links. Default session workspaces move to `<workspaces>/<owner>/<session_id>/`. The Codebox client moved to `src/environment/codebox.ts` behind the same interface; no configuration constructs it.

## Configuration

- `database.url` is required. The bundled `cordis.patch.yml` reads it from `AGENTRY_DATABASE_URL`.
- `codebox`, `CODEBOX_BASE_URL`, and `CODEBOX_API_KEY` are rejected at load with `CodeboxDisabledError`.
- `dataDir` is removed and rejected at load; `AGENTS_API_DATA_DIR` is no longer read.
- `artifacts` (S3) stays optional and is absent by default.

## Migration

Create a Postgres database, set `database.url` (or `AGENTRY_DATABASE_URL` with the bundled patch), and remove `dataDir` and any Codebox settings. Records in an old `dataDir` are not imported.
