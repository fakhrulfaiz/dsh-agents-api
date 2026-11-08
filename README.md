---
description: "Installable experimental profile layer that serves the OpenAI Agents API over REST and SSE for applications that already speak agents=v1."
kind: "package-bundle"

# @agentry/api

## Summary

Serve the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api) from a DeepSeek Harness Host so an OpenAI SDK or cURL client can create saved agents, open `sess_*` sessions, stream turn events, and send follow-up or cancel input. Choose it when the client already speaks `OpenAI-Beta: agents=v1`. The package is an experimental opt-in layer: shipped `web`, `headless`, `acp`, and `sdk` profiles do not include it. The Host profile still owns tools, sandboxing, and the model route; this layer maps HTTP onto `ctx.agents.create`, `followup`, `steer`, and `cancel`.

## Table of Contents

- [Use this package](#use-this-package)
- [Endpoints](#endpoints)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

---



## Use this package



### Install into a profile

Add this package with `dsh plugin add` on the shipped `web` profile. That profile already runs `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`. The command writes the profile for you; do not edit `~/.dsh` by hand. The browser and the Agents API then share that webserver: the UI stays on the web origin, and clients call the same host and port with `/v1`. This patch does not insert a second `id: webserver`.

```sh
pnpm dsh plugin --profile web add @agentry/api
pnpm dsh --profile web
```

Web owns the bind (default `127.0.0.1:3080`). This plugin adds `/v1` and `/health` on that server.

From a DSH checkout, point `add` at this repository (build it first with `pnpm build`; the plugin loads `lib/index.js`):

```sh
pnpm dsh plugin --profile web add ../dsh-agents-api
pnpm dsh plugin --profile web remove @agentry/api
```

Point the OpenAI client `baseURL` at the web server plus the prefix (for example `http://127.0.0.1:3080/v1`). Session create takes the Host provider from `ctx.agentDefaultModel.currentSelection()` and the model id from the Agents API `agent.model`.

### Develop in this repository

This repository builds and tests on its own against a pinned DSH checkout. `dsh.pin` names the DSH tag. Set up the pinned tree once (the artifact build takes several minutes), then work here:

```sh
git -C ../deepseek-harness worktree add ../dsh-pinned "$(cat dsh.pin)"
(cd ../dsh-pinned && pnpm install && pnpm run build:artifacts)
export DSH_ROOT=$PWD/../dsh-pinned   # required; no default
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

- `DSH_ROOT` is required and is never defaulted: `../deepseek-harness` is the live master checkout, not the pin. `typecheck`, `test`, and `build` first run `pnpm check:dsh-pin`, which fails when the tree is not at the `dsh.pin` tag or has changes to tracked files.
- `pnpm dsh:link` writes two untracked files: `tsconfig.dsh.json` (extends `$DSH_ROOT/tsconfig.base.json`; vitest resolves DSH sources through it) and `tsconfig.dsh.types.json` (maps DSH packages to their built `lib/types`; it fails when a package this repository imports has no declarations, which means `build:artifacts` was not run). Editors need `pnpm dsh:link` once before `tsconfig.test.json` resolves DSH imports.
- `typecheck` checks `src` against DSH declarations (`tsconfig.typecheck.json`), then `src`, `tests`, `scripts`, and `vitest.config.ts` (`tsconfig.test.json`).
- `vitest.config.ts` imports `standardDecoratorPlugin` from DSH's internal `vitest.shared.ts`; check it when bumping the pin.
- After a source change, run `pnpm build` and restart the profile that links this package.
- `pnpm test` needs a running Docker daemon: the store contract tests and the Loader composition test start a `postgres:16-alpine` container through Testcontainers and remove it when the file finishes.

### What you get

REST and SSE under the configured prefix (`/v1` by default) for saved agents, sessions, events, items, and turns. Clients should send `OpenAI-Beta: agents=v1`. Follow-ups use `agent.session.input.message`; steering vs a new turn follows Host idle vs in-progress; cancel uses `agent.session.input.cancel`. Wire `type: "function"` tools park Host execution until the client posts a tool result. Non-empty `agent.instructions` and client-supplied `type: "mcp"` tools mount on that same session. Use `[dsh-acp](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)` for Agent Client Protocol stdio, and `[dsh-sdk-jsonrpc-server](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md)` for the first-party JSON-RPC SDK. This gateway does not implement Assistants v2 `/v1/threads`.


| Field                       | Default | Meaning                                                                                                   |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `auth.mode`                 | none    | Required. `production` verifies Keycloak tokens and forbids `devKey` and `apiKeys`; `apiKeys` accepts named keys from `auth.apiKeys` (plus Keycloak tokens when `keycloak` is set) and forbids `devKey`; `development` allows `devKey`, `keycloak`, or both and forbids `apiKeys` (local key or API keys are tried first, then Keycloak) |
| `auth.apiKeys[]`            | none    | Mode `apiKeys`: non-empty list of `{ name, owner, roles, hash }`; `name` unique, `roles` a non-empty subset of `agentry-user`/`agentry-admin`, `hash` = `sha256:` + 64 lowercase hex of the full key |
| `auth.keycloak.issuer`      | none    | Realm issuer URL; JWKS is read from `${issuer}/protocol/openid-connect/certs`                             |
| `auth.keycloak.audience`    | none    | Required token `aud`                                                                                      |
| `auth.keycloak.jwksTtlSeconds` | `600` | JWKS cache lifetime                                                                                       |
| `auth.keycloak.jwksCooldownSeconds` | `30` | Minimum seconds between JWKS refetches caused by an unknown `kid`; `0` refetches on every unknown `kid` |
| `auth.keycloak.algorithms` | `['RS256']` | Accepted JWS algorithms                                                                          |
| `auth.keycloak.clockToleranceSeconds` | `5` | Allowed clock skew for `exp`/`nbf`                                                          |
| `auth.devKey.key`           | none    | Fixed bearer key (development only)                                                                       |
| `auth.devKey.owner`         | none    | Owner id the key acts as                                                                                  |
| `auth.devKey.admin`         | `true`  | Grant `agentry-admin` to the key                                                                          |
| `prefix`                    | `/v1`   | URL prefix for every Agents API route                                                                     |
| `database.url`              | none    | Required. Postgres connection URL for agents, templates, environments, and the session index. The bundled patch reads it from `AGENTRY_DATABASE_URL` |
| `workspaces`                | none    | Required. Root of `<owner>/<session>/` session workspaces and `<owner>/<environment>/` local environments. A missing or blank value fails at load. The bundled patch reads it from `AGENTRY_WORKSPACES` |
| `artifacts.*`               | absent  | Optional S3 artifact backend (`endpoint`, `bucket`, `prefix`, `region`, `accessKeyId`, `secretAccessKey`); off unless endpoint and credentials are set |
| `codebox`                   | —       | Rejected at load with `CodeboxDisabledError`, as are the `CODEBOX_BASE_URL` and `CODEBOX_API_KEY` env vars: Codebox environments are parked |
| `dataDir`                   | —       | Removed; rejected at load. Records live in Postgres                                                       |

The caller's owner is the token `sub`; roles come from `realm_access.roles` (`agentry-user`, `agentry-admin`). Missing or invalid credentials return 401 `unauthenticated` with `WWW-Authenticate: Bearer`; a principal holding neither `agentry-user` nor `agentry-admin` gets 403 `forbidden`. Tokens need `exp`, `sub`, and `typ: Bearer`. `/health` is unauthenticated. The bundled `cordis.patch.yml` runs in `development` mode with the key read from `AGENTRY_DEV_KEY`.

### Auth modes

| Mode | Credentials | Use |
|---|---|---|
| `production` | Keycloak access tokens | Teams, SSO, the full VM stack |
| `apiKeys` | Named API keys, optionally plus Keycloak tokens | Simple self-hosting without Keycloak |
| `development` | One shared `devKey`, optionally plus Keycloak tokens | Local development only; never in production |

Keys look like `agk_` followed by 43 base64url characters. Config stores only `sha256:` hashes; revoke a key by removing its entry. Create one (nothing is written to disk; the key is printed once):

```sh
pnpm keys:create --name ci --owner ali          # add --admin for agentry-admin
```

Put the printed entry in the plugin config and switch the mode (the hash below is an example, not a real key):

```yaml
auth:
  mode: apiKeys
  apiKeys:
    - name: ci
      owner: ali
      roles: [agentry-user]
      hash: sha256:0000000000000000000000000000000000000000000000000000000000000000
```

Every agent, template, environment, and session route reads and writes only the caller's records; another owner's record answers 404, never 403. At startup the plugin applies the numbered migrations in `src/store/migrations/` and opens a connection pool. Until then, and for good after a failed migration or connection (logged as `StoreStartError`), `/v1` answers 503 `store_unavailable`. A database error during a request also answers 503 `store_unavailable`.


The wire details for create, stream, and function tools live in [HTTP API](docs/http-api.md). The route list is below.

---

## Endpoints

Paths other than `/health` sit under the configured `prefix` (default `/v1`). Send `OpenAI-Beta: agents=v1`.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | Liveness check outside `/v1`. Returns `{ ok: true, service: "agents-api" }`. |
| `POST` | `/agents` | Save a new agent (`model` required). |
| `GET` | `/agents` | List saved agents. |
| `GET` | `/agents/{agent_id}` | Read one saved agent. |
| `POST` | `/agents/{agent_id}` | Update one saved agent. |
| `DELETE` | `/agents/{agent_id}` | Delete one saved agent. |
| `GET` | `/agents/tools` | List Host profile tools. `?session_id=` keeps only that session's `host_tools` mask; omit it for the full catalog. |
| `POST` | `/agents/environments/templates` | Save an environment template (`name` required). |
| `GET` | `/agents/environments/templates` | List environment templates. |
| `GET` | `/agents/environments/templates/{id}` | Read one template. |
| `POST` | `/agents/environments/templates/{id}` | Update one template's name or config. |
| `DELETE` | `/agents/environments/templates/{id}` | Delete one template. |
| `POST` | `/agents/environments` | Create a local environment: the directory `<workspaces>/<owner>/<environment_id>/`. `template_id` and `session_id` must name the caller's records. `environment.type: "sandbox"` on a session is rejected. |
| `GET` | `/agents/environments` | List the caller's environments. |
| `GET` | `/agents/environments/{id}` | Read one environment; its status becomes `failed` when the directory is gone. |
| `DELETE` | `/agents/environments/{id}` | Remove the directory and delete the record. |
| `POST` | `/agents/environments/{id}/files` | Write one file (`path` plus `content` or `content_base64`). Paths that escape the workspace are rejected. |
| `GET` | `/agents/environments/{id}/files` | List regular files in the workspace. |
| `GET` | `/agents/environments/{id}/files/{path}` | Read one file. |
| `POST` | `/agents/sessions` | Create a session from an inline `agent` and/or a saved `agent_id`. `stream: true` returns SSE. |
| `GET` | `/agents/sessions` | List the caller's sessions, newest first (`limit`, `after`; `order` is ignored). |
| `GET` | `/agents/sessions/{session_id}` | Read one session. |
| `POST` | `/agents/sessions/{session_id}` | Update `model`, `reasoning.effort`, `service_tier`, or `metadata`. |
| `DELETE` | `/agents/sessions/{session_id}` | Delete the session and any environments whose `session_id` is that session. |
| `POST` | `/agents/sessions/{session_id}/events` | Submit follow-up, cancel, or tool-result input. |
| `GET` | `/agents/sessions/{session_id}/events` | SSE stream. `Last-Event-ID` replays newer buffered events, then continues live. |
| `GET` | `/agents/sessions/{session_id}/items` | List the parent session's saved items. Items that belong to a subagent are omitted. |
| `GET` | `/agents/sessions/{session_id}/turns` | List the parent session's turns. |
| `GET` | `/agents/sessions/{session_id}/turns/{turn_id}` | Read one parent turn. |
| `GET` | `/agents/sessions/{session_id}/artifacts` | List session artifacts from the workspace, or from S3 when that endpoint is configured. |
| `GET` | `/agents/sessions/{session_id}/artifacts/{path}` | Download one artifact. A path that escapes the workspace is rejected. |
| `GET` | `/agents/sessions/{session_id}/subagents` | List Host children whose session header `origin` is `subagent`. |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}` | Read one child. |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}/turns` | List that child's turns. |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}/turns/{turn_id}` | Read one child turn. |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}/items` | List that child's items. Each item is stamped with `subagent_id`. |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}/turns/{turn_id}/items` | List items for one child turn. |

---



## Understand the implementation

Implementation internals

`[cordis.patch.yml](cordis.patch.yml)` inserts this plugin after `dsh-base` and `dsh-web-app`. It does not insert a webserver. The plugin is a function plugin (`name` / `inject` / `Config` / `apply`, no default export). `apply` registers `/health` and a `/v1` prefix handler on the web app's `webServer`, and fans `session/event` into Agents API SSE events plus a live item list. `/agents/sessions` is matched before `/agents/:agent_id` so the literal `sessions` segment is never captured as an agent id.

Each session calls `ctx.agents.create` with a `sess_*` id, `agentOptions.provider` from `agentDefaultModel`, and `agentOptions.model` from the wire agent, then `followup` or `steer`. Saved agents, templates, environments, and the session index live in Postgres through the `Store` interface (`src/store/`); session-local inline agents are materialized without appearing in `GET /agents`. Item listing accumulates from live `session/event` records and does not read historical Session logs. A `turn/end` with `reason.kind === 'error'` becomes `agent.session.turn.failed`; other ends become `agent.session.turn.completed`.


| File                                                             | Role                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[cordis.patch.yml](cordis.patch.yml)`                           | Insert this plugin onto the web app's webserver                                                                                                                                                   |
| `[src/index.ts](src/index.ts)`                                   | Plugin entry, prefix registration, Session-event bridge                                                                                                                                           |
| `[src/gateway.ts](src/gateway.ts)`                               | Ordered HTTP routes and Host agent lifecycle                                                                                                                                                      |
| `[src/session-registry.ts](src/session-registry.ts)`             | Session, turn, item, and SSE subscriber directory                                                                                                                                                 |
| `[src/agent-records.ts](src/agent-records.ts)`                   | Saved-agent record construction and update merge                                                                                                                                                  |
| `[src/store/store.ts](src/store/store.ts)`                       | `Store` interface, session cursor, outage errors                                                                                                                                                  |
| `[src/store/postgres.ts](src/store/postgres.ts)`                 | `Store` over a `pg` pool                                                                                                                                                                          |
| `[src/store/migrate.ts](src/store/migrate.ts)`                   | Forward-only, advisory-locked migrations from `src/store/migrations/`                                                                                                                             |
| `[src/environment/provider.ts](src/environment/provider.ts)`     | `EnvironmentProvider` interface                                                                                                                                                                   |
| `[src/environment/local.ts](src/environment/local.ts)`           | Local provider: `<workspaces>/<owner>/<environment_id>/` directories                                                                                                                              |
| `[src/environment/codebox.ts](src/environment/codebox.ts)`       | Parked Codebox client and provider; no configuration constructs it                                                                                                                                |
| `[src/items.ts](src/items.ts)`                                   | One Session event to saved items                                                                                                                                                                  |
| `[src/bridge.ts](src/bridge.ts)`                                 | Session events to Agents API output events                                                                                                                                                        |
| `[src/pending-function-calls.ts](src/pending-function-calls.ts)` | Parked client function-tool waiters and `requires_action`                                                                                                                                         |
| `[src/mount-function-tools.ts](src/mount-function-tools.ts)`     | Wire `type: "function"` → scoped Host tool registration                                                                                                                                           |
| `[src/mount-instructions.ts](src/mount-instructions.ts)`         | Non-empty `agent.instructions` → agent-scoped system-prompt section                                                                                                                               |
| `[src/mount-mcp-tools.ts](src/mount-mcp-tools.ts)`               | Wire `type: "mcp"` → per-session MCP client, loaded only when declared                                                                                                                           |
| —                                                                | No runtime invariant companion is published. Route dispatch, saved-agent CRUD, and live item lists are covered by HTTP and Loader tests; they do not compare independently produced observations. |







