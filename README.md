---
description: "Installable experimental profile layer that serves the OpenAI Agents API over REST and SSE for applications that already speak agents=v1."
kind: "package-bundle"

# @deepseek-ai/dsh-experimental-agents-api

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

The default path is `dsh plugin add` on a profile that already runs the web app. The browser and the Agents API then share that webserver: the UI stays on the web origin, and clients call the same host and port with `/v1`. This patch does not insert a second `id: webserver`.

```sh
pnpm dsh plugin --profile agents add @deepseek-ai/dsh-experimental-agents-api
pnpm dsh --profile agents
```

The `agents` profile bundle list is `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, then this package. Web owns the bind (default `127.0.0.1:3080`). This plugin adds `/v1` and `/health` on that server.

From this source checkout, point `add` at the package directory instead of the registry name:

```sh
pnpm dsh plugin --profile agents add ./packages/experimental/dsh-agents-api
pnpm dsh plugin --profile agents remove @deepseek-ai/dsh-experimental-agents-api
```

The CLI initializes the profile when needed. Point the OpenAI client `baseURL` at the web server plus the prefix (for example `http://127.0.0.1:3080/v1`). Session create takes the Host provider from `ctx.agentDefaultModel.currentSelection()` and the model id from the Agents API `agent.model`.

### Develop in this repository

When you change this package's source, rebuild the Host aggregate and restart the profile that linked it:

```sh
pnpm run build
pnpm dsh --profile agents
```

A `link:` dependency from `dsh plugin add ./packages/experimental/dsh-agents-api` loads that tree. Registry or GitHub installs load the published package and do not need monorepo `tsconfig` edits. The Host `tsconfig` reference and path alias exist only so in-tree tests and `pnpm run build` typecheck this package; they are not part of profile install.

### What you get

REST and SSE under the configured prefix (`/v1` by default) for saved agents, sessions, events, items, and turns. Clients should send `OpenAI-Beta: agents=v1`. Follow-ups use `agent.session.input.message`; steering vs a new turn follows Host idle vs in-progress; cancel uses `agent.session.input.cancel`. Wire `type: "function"` tools park Host execution until the client posts a tool result. Non-empty `agent.instructions` and client-supplied `type: "mcp"` tools mount on that same session. Use `[dsh-acp](../../acp/acp/README.md)` for Agent Client Protocol stdio, and `[dsh-sdk-jsonrpc-server](../../sdk/server/README.md)` for the first-party JSON-RPC SDK. This gateway does not implement Assistants v2 `/v1/threads`.


| Field    | Default | Meaning                                                              |
| -------- | ------- | -------------------------------------------------------------------- |
| `apiKey` | `''`    | Bearer token required in `Authorization`; empty string disables auth |
| `prefix` | `/v1`   | URL prefix for every Agents API route                                |


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
| `POST` | `/agents/environments` | Create a live environment. With no Codebox client this is a local directory. `environment.type: "sandbox"` on a session is rejected. |
| `GET` | `/agents/environments` | List live environments. |
| `GET` | `/agents/environments/{id}` | Read one environment and refresh it from Codebox when a box id is known. |
| `DELETE` | `/agents/environments/{id}` | Destroy the Codebox, when one exists, and delete the record. |
| `POST` | `/agents/environments/{id}/files` | Write one file into a connected Codebox (`path` plus `content` or `content_base64`). |
| `GET` | `/agents/environments/{id}/files` | List files under `/workspace` in a connected Codebox. |
| `GET` | `/agents/environments/{id}/files/{path}` | Read one file from a connected Codebox. |
| `POST` | `/agents/sessions` | Create a session from an inline `agent` and/or a saved `agent_id`. `stream: true` returns SSE. |
| `GET` | `/agents/sessions` | List sessions. |
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

Each session calls `ctx.agents.create` with a `sess_*` id, `agentOptions.provider` from `agentDefaultModel`, and `agentOptions.model` from the wire agent, then `followup` or `steer`. Saved agents live only in this process; session-local inline agents are materialized without appearing in `GET /agents`. Item listing accumulates from live `session/event` records and does not read historical Session logs. A `turn/end` with `reason.kind === 'error'` becomes `agent.session.turn.failed`; other ends become `agent.session.turn.completed`.


| File                                                             | Role                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[cordis.patch.yml](cordis.patch.yml)`                           | Insert this plugin onto the web app's webserver                                                                                                                                                   |
| `[src/index.ts](src/index.ts)`                                   | Plugin entry, prefix registration, Session-event bridge                                                                                                                                           |
| `[src/gateway.ts](src/gateway.ts)`                               | Ordered HTTP routes and Host agent lifecycle                                                                                                                                                      |
| `[src/session-registry.ts](src/session-registry.ts)`             | Session, turn, item, and SSE subscriber directory                                                                                                                                                 |
| `[src/agent-store.ts](src/agent-store.ts)`                       | Saved-agent CRUD                                                                                                                                                                                  |
| `[src/items.ts](src/items.ts)`                                   | One Session event to saved items                                                                                                                                                                  |
| `[src/bridge.ts](src/bridge.ts)`                                 | Session events to Agents API output events                                                                                                                                                        |
| `[src/pending-function-calls.ts](src/pending-function-calls.ts)` | Parked client function-tool waiters and `requires_action`                                                                                                                                         |
| `[src/mount-function-tools.ts](src/mount-function-tools.ts)`     | Wire `type: "function"` → scoped Host tool registration                                                                                                                                           |
| `[src/mount-instructions.ts](src/mount-instructions.ts)`         | Non-empty `agent.instructions` → agent-scoped system-prompt section                                                                                                                               |
| `[src/mount-mcp-tools.ts](src/mount-mcp-tools.ts)`               | Wire `type: "mcp"` → per-session MCP client, loaded only when declared                                                                                                                           |
| —                                                                | No runtime invariant companion is published. Route dispatch, saved-agent CRUD, and live item lists are covered by HTTP and Loader tests; they do not compare independently produced observations. |







