---

## description: "Installable experimental profile layer that serves the OpenAI Agents API over REST and SSE for applications that already speak agents=v1."
kind: "package-bundle"

# @deepseek-ai/dsh-experimental-agents-api

## Summary

Serve the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api) from a DeepSeek Harness Host so an OpenAI SDK or cURL client can create saved agents, open `sess_*` sessions, stream turn events, and send follow-up or cancel input. Choose it when the client already speaks `OpenAI-Beta: agents=v1`. The package is an experimental opt-in layer: shipped `web`, `headless`, `acp`, and `sdk` profiles do not include it. The Host profile still owns tools, sandboxing, and the model route; this layer maps HTTP onto `ctx.agents.create`, `followup`, `steer`, and `cancel`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

---



## Use this package



### Install into a profile

The default path is `dsh plugin add`. Create a dedicated base-backed profile first. Do not add this layer to the shipped `web` profile: that profile already owns `id: webserver`, and this patch inserts the same id.

```sh
pnpm dsh plugin --profile agents add @deepseek-ai/dsh-experimental-agents-api
pnpm dsh --profile agents
```

From this source checkout, point `add` at the package directory instead of the registry name:

```sh
pnpm dsh plugin --profile agents add ./packages/experimental/dsh-agents-api
pnpm dsh plugin --profile agents remove @deepseek-ai/dsh-experimental-agents-api
```

The CLI initializes the profile when needed. The patch inserts `dsh-host-webserver` on `0.0.0.0:3080` (`id: webserver`) and this plugin at prefix `/v1` (`id: agents-api`, empty `apiKey`). A later profile patch may replace either row's complete config. Point the OpenAI client `baseURL` at that server (for example `http://127.0.0.1:3080/v1`). Session create takes the Host provider from `ctx.agentDefaultModel.currentSelection()` and the model id from the Agents API `agent.model`.

### Develop in this repository

When you change this package's source, rebuild the Host aggregate and restart the profile that linked it:

```sh
pnpm run build
pnpm dsh --profile agents
```

A `link:` dependency from `dsh plugin add ./packages/experimental/dsh-agents-api` loads that tree. Registry or GitHub installs load the published package and do not need monorepo `tsconfig` edits. The Host `tsconfig` reference and path alias exist only so in-tree tests and `pnpm run build` typecheck this package; they are not part of profile install.

### What you get

REST and SSE under the configured prefix (`/v1` by default) for saved agents, sessions, events, items, and turns. Clients should send `OpenAI-Beta: agents=v1`. Follow-ups use `agent.session.input.message`; steering vs a new turn follows Host idle vs in-progress; cancel uses `agent.session.input.cancel`. Wire `type: "function"` tools park Host execution until the client posts a tool result. Use `[dsh-acp](../../acp/acp/README.md)` for Agent Client Protocol stdio, and `[dsh-sdk-jsonrpc-server](../../sdk/server/README.md)` for the first-party JSON-RPC SDK. This gateway does not implement Assistants v2 `/v1/threads`.


| Field    | Default | Meaning                                                              |
| -------- | ------- | -------------------------------------------------------------------- |
| `apiKey` | `''`    | Bearer token required in `Authorization`; empty string disables auth |
| `prefix` | `/v1`   | URL prefix for every Agents API route                                |


The HTTP route table and wire semantics live in [HTTP API](docs/http-api.md).

---



## Understand the implementation

Implementation internals

`[cordis.patch.yml](cordis.patch.yml)` inserts the webserver and this plugin after `dsh-base`. The plugin is a function plugin (`name` / `inject` / `Config` / `apply`, no default export). `apply` registers a prefix handler through `ctx.effect` and fans `session/event` into Agents API SSE events plus a live item list. `/agents/sessions` is matched before `/agents/:agent_id` so the literal `sessions` segment is never captured as an agent id.

Each session calls `ctx.agents.create` with a `sess_*` id, `agentOptions.provider` from `agentDefaultModel`, and `agentOptions.model` from the wire agent, then `followup` or `steer`. Saved agents live only in this process; session-local inline agents are materialized without appearing in `GET /agents`. Item listing accumulates from live `session/event` records and does not read historical Session logs. A `turn/end` with `reason.kind === 'error'` becomes `agent.session.turn.failed`; other ends become `agent.session.turn.completed`.


| File                                                             | Role                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[cordis.patch.yml](cordis.patch.yml)`                           | Insert list for webserver and this plugin                                                                                                                                                         |
| `[src/index.ts](src/index.ts)`                                   | Plugin entry, prefix registration, Session-event bridge                                                                                                                                           |
| `[src/gateway.ts](src/gateway.ts)`                               | Ordered HTTP routes and Host agent lifecycle                                                                                                                                                      |
| `[src/session-registry.ts](src/session-registry.ts)`             | Session, turn, item, and SSE subscriber directory                                                                                                                                                 |
| `[src/agent-store.ts](src/agent-store.ts)`                       | Saved-agent CRUD                                                                                                                                                                                  |
| `[src/items.ts](src/items.ts)`                                   | One Session event to saved items                                                                                                                                                                  |
| `[src/bridge.ts](src/bridge.ts)`                                 | Session events to Agents API output events                                                                                                                                                        |
| `[src/pending-function-calls.ts](src/pending-function-calls.ts)` | Parked client function-tool waiters and `requires_action`                                                                                                                                         |
| `[src/mount-function-tools.ts](src/mount-function-tools.ts)`     | Wire `type: "function"` → scoped Host tool registration                                                                                                                                           |
| —                                                                | No runtime invariant companion is published. Route dispatch, saved-agent CRUD, and live item lists are covered by HTTP and Loader tests; they do not compare independently produced observations. |




---



## Further Exploration

- [Experimental packages](../README.md) — publication policy and dependency isolation.
- [HTTP API](docs/http-api.md) — routes, create/stream input, and function-tool wire contract.
- [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api) — the wire contract this gateway implements.
- [dsh-acp](../../acp/acp/README.md) — the automation-only stdio protocol for non-HTTP clients.

---



## Model Experience



### Session input text



#### What the model sees

Each non-empty `input` string or `input_text` part from `POST /agents/sessions` and from `agent.session.input.message` becomes one Host user message (`source.kind: user`).

#### Token effect

Those user messages remain in the Session until ordinary compaction replaces or removes that history.

#### KV Cache effect

Follow-up and steering append to the existing Session. They do not replace the reusable prefix of earlier completed turns. A new session starts a new prefix.

### Wire function tools



#### What the model sees

Wire `type: "function"` tools on `agent.tools` mount as scoped Host tools; a model call parks Host `execute`, sets session status to `requires_action`, and lists the pending call in `required_actions` until the client posts `agent.session.input.tool_result` (or legacy `agent.session.input.function_call_output`) with the matching `call_id`, which appends a real Host `tool/result` rather than a user follow-up. Profile tools remain available and stack with wire functions; a same-name scoped wire tool shadows the profile global for that session.

#### Token effect

Tool results remain in the Session until ordinary compaction replaces or removes that history.

#### KV Cache effect

Completing a parked function call appends to the existing Session prefix; it does not rewrite earlier completed turns.

## Known Limitations and Deferred Work



- **Experimental opt-in layer** — shipped `web` / `headless` / `acp` / `sdk` profiles do not include this package; add it to a dedicated base-backed profile.
- **Do not stack onto the shipped web profile** — that profile already inserts `id: webserver`; this patch inserts the same id.
- `openai_hosted` **does not provision an OpenAI sandbox** — the Host uses `process.cwd()` unless `environment.type` is `self_hosted` with an absolute `workspace_directory`.
- **Only** `type: "function"` **tools are mounted** — MCP, `web_search`, `programmatic_tool_calling`, `tool_search`, and `defer_loading` are rejected at create time; use the Host profile for those capabilities.
- **Session setting updates stay on the Agents API resource** — `POST /agents/sessions/{id}` records `model`, `reasoning.effort`, and `service_tier` for later reads; it does not retarget the live Host agent.
- **Saved agents are process-local** — `GET /agents` lists agents created in this process; they are not durable across restart.
- **SSE does not replay** — after disconnect, retrieve the session and `GET .../items`; the event stream only emits from subscribe time.



### Dev Note

Working context for maintainers — click to expand

Default product path is explicit `dsh plugin add`, not `OPTIONAL_BUNDLES`. In-tree Host project registration is build-only.

