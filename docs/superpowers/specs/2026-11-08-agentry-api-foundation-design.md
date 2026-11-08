# Agentry API foundation — design

Date: 2026-11-08 · Status: awaiting user review · Scope: sub-projects 1 (API hardening + admin API) and 2 (combined profile + VM container)

Decisions referenced here are recorded in [AGENTS.md](../../../AGENTS.md#decisions-do-not-re-litigate). This spec does not repeat their rationale.

## 1. Goal and success criteria

Turn this repository into **Agentry API**: an OpenAI Agents API–compatible DSH plugin, plus an admin API, that runs in one Docker container on a VM and survives restarts.

Success means all of the following hold on the pinned DSH release tag:

1. A wire `type: "function"` tool turn completes end to end against a live model (`agents-api-client/function_tool_smoke.py`).
2. After a host restart, a session's items and turns are returned unchanged, and an SSE client reconnecting with `Last-Event-ID` receives every missed event.
3. A DSH approval request (sandbox escalation or user question) surfaces as `requires_action` and resumes the turn when answered over the API.
4. Requests without a valid Keycloak access token are rejected; non-admin tokens cannot reach `/admin/v1`; every non-admin query returns only the caller's records.
5. An admin can list and search all sessions and retrieve the full model request of any step; a golden test proves the returned request equals what the provider received.
6. `docker compose up` on a clean VM starts Caddy, Keycloak, Postgres, and the `agentry` container; `/health` is green; a sandboxed command writing outside its workspace is denied.

## 2. Out of scope

Multi-user isolation (beyond `owner` columns and filters), per-session cloud sandboxes (Daytona/E2B), Codebox execution, S3 artifacts (code stays, disabled by default), cowork endpoints (jobs, schedules, deliverables, plan/todo/goal, team board), and the frontend (`agentry-web`). These belong to later sub-projects. A SQLite `Store` implementation for zero-dependency simple hosting is a planned follow-up behind the same `Store` interface; this round ships Postgres only.

## 3. Repository and packaging

- Rename the repository to `agentry-api` and the package to `@agentry/api`. Update `README.md`, `cordis.patch.yml`, `docs/`, and the client smokes in `agents-api-client`.
- DSH packages (`cordis`, `dsh-agent`, `dsh-agent-default-model`, `dsh-host-webserver`, `dsh-llm`, `dsh-mcp-client`, `dsh-session`, `dsh-session-query`, `dsh-config-editor`, `dsh-system-prompt`, `dsh-tools`) are `peerDependencies` supplied by the host DSH install. Replace the current `workspace:^` ranges with ranges that the pinned tag satisfies.
- Development typecheck and tests resolve DSH imports through TypeScript `paths` to a pinned checkout, located by the `DSH_ROOT` environment variable (required; no default, because `../deepseek-harness` is the live master checkout, not the pin). A `scripts/check-dsh-pin.ts` script fails when that checkout is not at the tag named in `dsh.pin` (a one-line file in the repository root).
- Restore `CHANGELOG.md` (carried over from the stale copy in `deepseek-harness/packages/experimental/agents-api`) and the Agent Note on parked function tools into `docs/changes/`. Then delete the stale copy.
- The package entry point is built `lib/index.js` (tsdown). Remove the `./src/*` export and `src/entry.js`.

## 4. Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `auth/authenticator.ts` | `Authenticator` interface: `authenticate(req) → Principal \| AuthError`. `Principal = { owner: OwnerId; roles: ReadonlySet<Role> }` | — |
| `auth/keycloak.ts` | Keycloak JWT implementation: JWKS fetch with cache and key-rotation refetch, `iss`/`aud`/`exp`/`nbf` checks, `owner = sub`, roles from `realm_access.roles` | `jose` |
| `auth/static-key.ts` | Development-only bearer key mapped to one configured owner with an optional admin role. Config rejects it when `mode: production` | — |
| `store/store.ts` | `Store` interface for owners, agents, environments, templates, the sessions index, and admin audit | — |
| `store/postgres.ts` | `Store` over `pg`: owner-scoped queries, transactions | `pg` |
| `store/migrations/NNNN-*.sql` | Numbered forward-only migrations, applied at startup inside one advisory-locked transaction | — |
| `history/session-history.ts` | Items, turns, and steps read from the DSH Session log through `ctx.sessionQuery`, mapped by the existing `items.ts` / `bridge.ts` logic | `dsh-session-query` |
| `stream/event-log.ts` | Per-session monotonic event sequence; replay of wire events from Session history for `Last-Event-ID` | `history` |
| `approvals/approval-bridge.ts` | Maps DSH interaction requests to `requires_action` entries and wire answers back to the interaction service | DSH interaction service |
| `admin/admin-gateway.ts` | `/admin/v1` routes (section 6) | `store`, `history`, `request-reconstruction`, `dsh-config-editor` |
| `admin/request-reconstruction.ts` | Full model request for one step (section 6.2) | `history`, DSH projections |
| `gateway.ts` | Existing `/v1` routes, now owner-scoped and backed by `store` + `history` | all of the above |
| `environment/provider.ts` | `EnvironmentProvider` interface (`create`, `status`, `destroy`, `listFiles`, `readFile`, `writeFile`) | — |
| `environment/local.ts` | Local provider: `workspaces/<owner>/<environment-id>/` directory | — |
| `environment/codebox.ts` | Existing Codebox client behind the interface; config rejects it until per-session execution exists | — |

Existing modules (`http.ts`, `sse.ts`, `input.ts`, `items.ts`, `bridge.ts`, `mount-*.ts`, `pending-function-calls.ts`, `artifacts.ts`) are kept and adapted. `agent-store.ts`, `durable-store.ts`, and the in-memory parts of `session-registry.ts` are replaced by `store` and `history`.

## 5. Agents API hardening (`/v1`)

### 5.1 Storage

Postgres tables (initial migration `0001`):

- `owners(id text pk, created_at timestamptz)`: a row is created on an owner's first authenticated request.
- `agents(id text pk, owner_id text fk, body jsonb, created_at, updated_at)`
- `environment_templates(id text pk, owner_id, body jsonb, created_at, updated_at)`
- `environments(id text pk, owner_id, provider text, status text, workspace_path text, body jsonb, created_at, updated_at)`
- `sessions(id text pk, owner_id, agent_id text null, environment_id text null, dsh_session_id text not null, status text, last_error text null, model text, reasoning_effort text null, created_at, updated_at)`
- `admin_audit(id bigserial pk, actor text, action text, target text, at timestamptz)`

Indexes: `(owner_id, created_at desc)` on every owner-scoped table; `sessions(status)`.

Items, turns, and steps are **not** stored in Postgres; they are read from the DSH Session log.

Migration `0002` (approved by the user 2026-11-08) adds `sessions.body jsonb`: the session's resolved setup (agent configuration, instructions, tools, host tool mask, environment, metadata, vault ids) needed to rebuild the agent on resume. It holds no conversation content and no model requests. Rows without `body` cannot be resumed and are marked `interrupted`.

### 5.2 Restart recovery

At startup, after migrations, every `sessions` row with status `in_progress` or `requires_action` is either resumed through the DSH agent lifecycle from its Session log or marked `interrupted` with a `last_error` explaining why it could not be resumed. Status changes are written in the same code path that emits the corresponding wire event.

### 5.3 SSE replay

Each emitted wire event carries `id: <seq>`, where `seq` is the event's position in the session's derived wire event sequence. `GET …/events?stream=true` with a `Last-Event-ID` header first replays events with a greater `seq` (derived from Session history), then continues live without gaps or duplicates. Without the header the stream starts live, as it does today.

### 5.4 Approvals

When DSH raises an interaction request for a session (sandbox escalation, user question), the session status becomes `requires_action` and `required_actions` gains an entry `{ type: "approval", id, kind, prompt, options }`. The client answers with a new input event `agent.session.input.approval_response { id, decision, payload? }`. An unknown id fails with 404. Answering resumes the DSH interaction. The exact mapping to the DSH interaction service is fixed during implementation from `packages/interaction` and documented in `docs/http-api.md`.

### 5.5 Live session updates

`POST /agents/sessions/{id}` with `model` or `reasoning.effort` applies the change to the running DSH agent when DSH exposes a supported way to change it, and stores it. When it cannot be applied, the request fails with `409 session_setting_not_live` and nothing is stored.

### 5.6 Auth on `/v1`

Every request is authenticated. Missing or invalid credentials return `401`; all reads and writes are restricted to `principal.owner`. Records of other owners return `404`, not `403`.

### 5.7 Auth modes

`auth.mode` selects how credentials are checked. All modes produce the same `Principal` and sit behind the `Authenticator` interface.

| Mode | Credentials | Intended use |
|---|---|---|
| `production` | Keycloak access tokens (`auth.keycloak`) | Teams, SSO, the full VM stack |
| `apiKeys` | Named API keys (`auth.apiKeys`), optionally plus Keycloak tokens when `auth.keycloak` is also set | Simple self-hosting without Keycloak |
| `development` | One shared `devKey`, optionally plus Keycloak tokens | Local development only |

`apiKeys` entries are `{ name, owner, roles, hash }`. Keys have the form `agk_` + 43 base64url characters (32 random bytes); `hash` is `sha256:` + the lowercase hex SHA-256 of the full key. Config holds hashes only, never plaintext keys. Verification hashes the presented bearer and compares it against every entry with `timingSafeEqual`. `name` values are unique, `roles` is a non-empty subset of `agentry-user`/`agentry-admin`, and an empty list, a duplicate name, or a malformed hash fails at load. Revoking a key means removing its entry. `pnpm keys:create --name <name> --owner <owner> [--admin]` prints a new key once and the matching config entry; it writes no files. `devKey` stays rejected outside `development`.

## 6. Admin API (`/admin/v1`)

### 6.1 Routes

Requires the `agentry-admin` realm role (`403` otherwise). Every call writes one `admin_audit` row.

| Method | Route | Result |
|---|---|---|
| `GET` | `/sessions?owner=&agent=&status=&from=&to=&q=&cursor=` | Sessions across owners; `q` uses `sessionQuery.searchSessions` |
| `GET` | `/sessions/{id}` | Index row plus `sessionQuery.traceSession` tree |
| `GET` | `/sessions/{id}/messages` | User and assistant messages |
| `GET` | `/sessions/{id}/steps` | Steps with turn id, model, token usage, start and end time |
| `GET` | `/sessions/{id}/steps/{step_id}/request` | Full model request (section 6.2) |
| `GET` | `/sessions/{id}/log?cursor=` | Raw Session events, paginated |
| `GET` | `/config` | Plugin config schemas and current values from `dsh-config-editor` |
| `PATCH` | `/config/{entry_id}` | Validated config write applied live; a rejected write leaves the profile patch unchanged |
| `GET` | `/health/details` | Versions, DSH tag, Postgres and Keycloak reachability, sandbox enforcement level |

### 6.2 Full model request

`request` returns `{ system, tools, messages, model, parameters }` for one step, rebuilt from the Session log using DSH message projections and Session tool history at that step's position.

**Spike first (the first task in this area):** confirm that DSH can rebuild a past step's request from the log. Acceptance: for a recorded multi-turn session with tool calls and compaction, the rebuilt request equals the request captured at the fake provider.

**If the spike fails:** capture the final outgoing request through DSH's model-request hook into a Postgres `model_requests(session_id, step_id, body jsonb, bytes int, created_at)` table with a configurable size limit and retention period. Taking this branch amends AGENTS.md decision 7, and the amendment is part of the same change.

## 7. Combined profile and container

### 7.1 Profile

`deploy/profile/` contains the `agentry` profile:

- `package.json` with `dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@agentry/api"]`.
- `cordis.patch.yml` with deployment values only: `agentry` config (auth mode, Keycloak issuer and audience, Postgres URL, `workspacesRoot: /data/workspaces`), `sandbox-policy` default `workspace-write`, and the webserver bind address and `publicUrl`. Every secret is `!!js process.env.<NAME>`, including `DEEPSEEK_API_KEY`.

`@agentry/api`'s own `cordis.patch.yml` inserts only its plugin row and registers `/v1`, `/admin/v1`, and `/health` on the web app's `id: webserver`.

### 7.2 Image

`deploy/Dockerfile`:

1. Build stage: clone DSH at the tag in `dsh.pin`, `pnpm install --frozen-lockfile`, `pnpm run build:artifacts`.
2. Build agentry-api and install the `agentry` profile against that DSH tree.
3. Runtime stage: non-root user, `tini` as PID 1, volumes `/data/dsh` and `/data/workspaces`, no Docker socket. Entry point: `dsh --profile agentry`.

### 7.3 Compose

`deploy/compose.yml` services: `caddy` (public `:443`, TLS), `keycloak` (realm import from `deploy/keycloak/realm-agentry.json` with roles `agentry-user` and `agentry-admin`), `postgres` (databases `agentry` and `keycloak`), and `agentry` (private network only; optional `runtime: runsc`). Secrets come from an untracked `deploy/.env` with a committed `deploy/.env.example`. The DSH web UI at `/` is not routed publicly; reach it through an SSH tunnel. Nightly `pg_dump` and `/data/dsh` snapshot scripts live in `deploy/backup/`.

`deploy/compose.simple.yml` is the simple-hosting variant: `caddy`, `postgres` (database `agentry` only), and `agentry` with `auth.mode: apiKeys`; no Keycloak service.

### 7.4 Startup checks

Startup fails with a named error when: Postgres is unreachable, a migration fails, the Keycloak JWKS endpoint is unreachable (production mode), the static-key authenticator is configured in production mode, `DEEPSEEK_API_KEY` is unset, or `sandbox-local` reports `SANDBOX_UNAVAILABLE`. The enforcement level (`full` or `partial`) is logged at startup.

## 8. Error handling

- Wire errors use the existing `errors.ts` JSON body. New codes: `unauthenticated` (401), `forbidden` (403), `session_setting_not_live` (409), `approval_not_found` (404), `store_unavailable` (503).
- A Postgres failure during a request returns `503` and never leaves a wire event emitted without its status write.
- Restart recovery never silently drops a session: each one ends `resumed` or `interrupted` with a reason.

## 9. Testing

- **Unit (vitest):** existing specs adapted; `Store` against real Postgres (Testcontainers); migrations from an empty database; owner scoping; `Authenticator` with a local signing key (valid, expired, wrong `iss`, wrong `aud`, missing admin role); SSE replay; approval mapping.
- **Integration:** in-process DSH host on the pinned tag with a fake model provider; create → turn → restart → history intact; admin request-reconstruction golden test (section 6.2).
- **Live (manual, needs `DEEPSEEK_API_KEY`):** `agents-api-client` smokes against the container; `function_tool_smoke.py` first.
- **Container:** clean `docker compose up`, `/health` green, workspace-escape write denied, enforcement level logged; optionally under `runsc`.
- **Contract:** `openapi/agentry.yaml` for `/v1` and `/admin/v1`; a CI test fails when the registered routes and the spec diverge.
- **CI (GitHub Actions):** DSH pin check, typecheck, unit, Postgres integration, OpenAPI drift. Live e2e stays manual.

## 10. Implementation order

1. Live check: `function_tool_smoke.py` against the current repository on the new DSH master (settles the removed `TOOL_RUNTIME_SCHEDULER` question).
2. Repository rename, packaging, DSH pin, `CHANGELOG.md` restore, stale copy removal.
3. `Authenticator` with the Keycloak and static-key implementations.
4. Postgres `Store` and migrations; replace the in-memory and JSON stores.
4b. `apiKeys` auth mode and the `keys:create` command (section 5.7).
5. Session history from the DSH log; restart recovery; SSE replay.
6. Approvals bridge; live session updates.
7. Request-reconstruction spike, then the admin API.
8. Profile, Dockerfile, compose, Keycloak realm, startup checks.
9. OpenAPI spec and CI.
