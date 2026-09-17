---
description: "Installable experimental profile layer that serves the OpenAI Agents API over REST and SSE for applications that already speak agents=v1."
kind: "package-bundle"
---

# @fakhrulfaiz/dsh-agents-api

English | [中文](README.zh.md)

## Summary

Serve the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api) from a DeepSeek Harness Host so an OpenAI SDK or cURL client can create saved agents, open `sess_*` sessions, stream turn events, and send follow-up or cancel input. Choose it when the client already speaks `OpenAI-Beta: agents=v1`. The package is experimental and installable: it is not part of the shipped `web`, `headless`, `acp`, or `sdk` profiles. The Host profile still owns tools, sandboxing, and the model route; this plugin maps HTTP onto `ctx.agents.create`, `followup`, `steer`, and `cancel`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside `dsh-host-webserver`, `dsh-session`, `dsh-agent`, and `dsh-agent-default-model` (the loop factory must already be registered), then point the OpenAI client `baseURL` at that server. Session create takes the Host **provider** from `ctx.agentDefaultModel.currentSelection()` and the **model** id from the Agents API `agent.model`.

### Install from GitHub

Use this when you want the package in a profile without editing its source. Create a dedicated base-backed profile first. Do not add it to the shipped `web` profile: that profile already owns `id: webserver`.

```sh
pnpm dsh plugin --profile agents add github:fakhrulfaiz/dsh-agents-api
pnpm dsh plugin --profile agents remove @fakhrulfaiz/dsh-agents-api
```

If pnpm blocks the git `prepare` / `tsdown` build, allow it in the profile's `pnpm-workspace.yaml`, then re-run `add`:

```yaml
allowBuilds:
  '@fakhrulfaiz/dsh-agents-api': true
```

The CLI initializes the profile when needed. The patch inserts `dsh-host-webserver` on `0.0.0.0:3080` (`id: webserver`) and this plugin at prefix `/v1` (`id: agents-api`, empty `apiKey`). A later profile patch may replace either row's complete config.

### Develop from a local checkout

Use this when you are changing this package. Point the profile at a local tree (absolute path, or a path relative to the DeepSeek Harness checkout that runs `pnpm dsh`).

From a DeepSeek Harness checkout that contains `packages/experimental/agents-api`:

```sh
pnpm dsh plugin --profile agents add ./packages/experimental/agents-api
```

From any clone of this repository:

```sh
pnpm dsh plugin --profile agents add /absolute/path/to/dsh-agents-api
```

After you edit `src/`, run `pnpm build` in the package directory (or let install run `prepare`), then restart the profile. A `link:` dependency in the profile's `package.json` means profile runs load that local tree; a `github:` dependency means they load the remote commit until you `add` again.
### When to choose it

Choose it for OpenAI Agents API clients that need REST plus SSE against a local Host. Use [`dsh-acp`](../../acp/acp/README.md) for Agent Client Protocol stdio, and [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.md) for the first-party JSON-RPC SDK. This gateway does not implement Assistants v2 `/v1/threads`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '127.0.0.1'
    port: 3080
- name: '@fakhrulfaiz/dsh-agents-api'
  config:
    apiKey: ''
    prefix: '/v1'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `''` | Bearer token required in `Authorization`; empty string disables auth |
| `prefix` | `/v1` | URL prefix for every Agents API route |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agents-api) is the exhaustive source for every accepted field and its JSDoc.

Requests should send `OpenAI-Beta: agents=v1`. Official routes under the configured prefix:

| Method | Path | Role |
|---|---|---|
| `POST` `GET` | `/agents` | Create or list saved agents |
| `GET` `POST` `DELETE` | `/agents/{agent_id}` | Retrieve, update, or delete a saved agent |
| `POST` `GET` | `/agents/sessions` | Create or list sessions (`agent` object and/or `agent_id`) |
| `GET` `POST` `DELETE` | `/agents/sessions/{session_id}` | Retrieve, update (`model` / `reasoning.effort` / `service_tier` / `metadata`), or delete |
| `POST` `GET` | `/agents/sessions/{session_id}/events` | Submit input events; `GET` is the SSE stream (`?stream=true`) |
| `GET` | `/agents/sessions/{session_id}/items` | List saved items (`order=asc` by default) |
| `GET` | `/agents/sessions/{session_id}/turns` | List turns |
| `GET` | `/agents/sessions/{session_id}/turns/{turn_id}` | Retrieve one turn |

`POST /agents/sessions` accepts `input` as a string or `input_text` messages and `stream: true` for SSE on the create response. Follow-ups use `agent.session.input.message`; steering vs a new turn follows Host idle vs in-progress; cancel uses `agent.session.input.cancel`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin is a function plugin (`name` / `inject` / `Config` / `apply`, no default export). `apply` registers a prefix handler through `ctx.effect` and fans `session/event` into Agents API SSE events plus a live item list. `/agents/sessions` is matched before `/agents/:agent_id` so the literal `sessions` segment is never captured as an agent id.

Each session calls `ctx.agents.create` with a `sess_*` id (the ACP create path), `agentOptions.provider` from `agentDefaultModel`, and `agentOptions.model` from the wire agent, then `followup` or `steer`. Saved agents live only in this process; session-local inline agents are materialized without appearing in `GET /agents`. Item listing accumulates from live `session/event` records and does not read historical Session logs. A `turn/end` with `reason.kind === 'error'` becomes `agent.session.turn.failed`; other ends become `agent.session.turn.completed`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, prefix registration, Session-event bridge |
| [`src/gateway.ts`](src/gateway.ts) | Ordered HTTP routes and Host agent lifecycle |
| [`src/session-registry.ts`](src/session-registry.ts) | Session, turn, item, and SSE subscriber directory |
| [`src/agent-store.ts`](src/agent-store.ts) | Saved-agent CRUD |
| [`src/items.ts`](src/items.ts) | One Session event to saved items |
| [`src/bridge.ts`](src/bridge.ts) | Session events to Agents API output events |
| [`src/pending-function-calls.ts`](src/pending-function-calls.ts) | Parked client function-tool waiters and `requires_action` |
| [`src/mount-function-tools.ts`](src/mount-function-tools.ts) | Wire `type: "function"` → scoped Host tool registration |
| [`cordis.patch.yml`](cordis.patch.yml) | Insert list for webserver and this plugin |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication policy and dependency isolation.
- [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api) — the wire contract this gateway implements.
- [dsh-acp](../../acp/acp/README.md) — the automation-only stdio protocol for non-HTTP clients.
- [OpenAI Agents API HTTP gateway](../../../.agents/notes/implemented/feature/2026-09-17-openai-agents-api-http-gateway.md) — routing, create path, and item-projection decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Session input text

#### What the model sees

Each non-empty `input` string or `input_text` part from `POST /agents/sessions` and from `agent.session.input.message` becomes one Host user message (`source.kind: user`).

Wire `type: "function"` tools on `agent.tools` are mounted as scoped Host tools. When the model calls one, the Host parks `execute`, the session status becomes `requires_action`, and `required_actions` lists the pending call. Post `agent.session.input.tool_result` (or the legacy alias `agent.session.input.function_call_output`) with the matching `call_id` to complete the Host tool and continue the turn. That path appends a real Host `tool/result`; it does not submit a user follow-up.

Profile tools from the Host composition stay available and stack with wire functions. A same-name scoped wire tool shadows the profile global for that session.

#### Token effect

Those user messages and tool results remain in the Session until ordinary compaction replaces or removes that history.

#### KV Cache effect

Follow-up and steering append to the existing Session. They do not replace the reusable prefix of earlier completed turns. A new session starts a new prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Experimental opt-in layer** — shipped `web` / `headless` / `acp` / `sdk` profiles do not include this package; add it to a dedicated base-backed profile.
- **Do not stack onto the shipped web profile** — that profile already inserts `id: webserver`; this patch inserts the same id.
- **`openai_hosted` does not provision an OpenAI sandbox** — the Host uses `process.cwd()` unless `environment.type` is `self_hosted` with an absolute `workspace_directory`.
- **Only `type: "function"` tools are mounted** — MCP, `web_search`, `programmatic_tool_calling`, `tool_search`, and `defer_loading` are rejected at create time; use the Host profile for those capabilities.
- **Session setting updates stay on the Agents API resource** — `POST /agents/sessions/{id}` records `model`, `reasoning.effort`, and `service_tier` for later reads; it does not retarget the live Host agent.
- **Saved agents are process-local** — `GET /agents` lists agents created in this process; they are not durable across restart.
- **SSE does not replay** — after disconnect, retrieve the session and `GET .../items`; the event stream only emits from subscribe time.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Route dispatch, saved-agent CRUD, and live item lists are covered by HTTP and Loader tests; they do not compare independently produced observations.
