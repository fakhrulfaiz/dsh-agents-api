# Agents API HTTP routes

Route and wire detail for `@deepseek-ai/dsh-experimental-agents-api`. Install and profile composition live in the [package README](../README.md).

## Official routes

Requests should send `OpenAI-Beta: agents=v1`. Paths below are relative to the configured `prefix` (default `/v1`).

| Method | Path | Role |
|---|---|---|
| `POST` `GET` | `/agents` | Create or list saved agents |
| `GET` | `/agents/tools` | List Host profile tools. `?session_id=` keeps only that session's `host_tools` mask; omit it for the full catalog |
| `POST` `GET` | `/agents/environments/templates` | Create or list environment templates |
| `GET` `POST` `DELETE` | `/agents/environments/templates/{id}` | Retrieve, update, or delete one template |
| `POST` `GET` | `/agents/environments` | Create or list live environments. No Codebox client returns `provider: "local"` |
| `GET` `DELETE` | `/agents/environments/{id}` | Retrieve (refresh) or delete one environment |
| `POST` `GET` | `/agents/environments/{id}/files` | Write or list files in a connected Codebox |
| `GET` | `/agents/environments/{id}/files/{path}` | Read one Codebox file |
| `GET` `POST` `DELETE` | `/agents/{agent_id}` | Retrieve, update, or delete a saved agent |
| `POST` `GET` | `/agents/sessions` | Create or list sessions (`agent` object and/or `agent_id`) |
| `GET` `POST` `DELETE` | `/agents/sessions/{session_id}` | Retrieve, update (`model` / `reasoning.effort` / `service_tier` / `metadata`), or delete |
| `POST` `GET` | `/agents/sessions/{session_id}/events` | Submit input events; `GET` is the SSE stream (`?stream=true`) |
| `GET` | `/agents/sessions/{session_id}/items` | List saved items (`order=asc` by default) |
| `GET` | `/agents/sessions/{session_id}/turns` | List turns |
| `GET` | `/agents/sessions/{session_id}/turns/{turn_id}` | Retrieve one turn |
| `GET` | `/agents/sessions/{session_id}/artifacts` | List session artifacts from the workspace, or from S3 when that endpoint is configured |
| `GET` | `/agents/sessions/{session_id}/artifacts/{path}` | Download one artifact. Paths that escape the workspace are rejected |
| `GET` | `/agents/sessions/{session_id}/subagents` | List Host children whose header `origin` is `subagent` |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}` | Retrieve one child |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}/turns` | List that child's turns |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}/turns/{turn_id}` | Retrieve one child turn |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}/items` | List that child's items |
| `GET` | `/agents/sessions/{session_id}/subagents/{subagent_id}/turns/{turn_id}/items` | List items for one child turn |

## Session create and follow-up

`POST /agents/sessions` accepts `input` as a string or `input_text` messages and `stream: true` for SSE on the create response. Follow-ups use `agent.session.input.message`. Steering vs a new turn follows Host idle vs in-progress. Cancel uses `agent.session.input.cancel`.

## Function tools

1. Create a session with `agent.tools: [{ type: "function", name, description?, parameters? }]`.
2. Stream until `agent.session.requires_action` (or read `session.required_actions`).
3. Post `agent.session.input.tool_result` with `turn_id`, `call_id`, and either `success: true` + `output` or `success: false` + `error`.
4. Legacy alias: `agent.session.input.function_call_output` maps to a successful completion.

Harness profile tools remain available and stack with wire functions. A same-name scoped wire tool shadows the profile global for that session. `web_search`, `programmatic_tool_calling`, `tool_search`, and `defer_loading` are rejected at create time.

Non-empty `agent.instructions` is mounted as Host system-prompt section `agents-api:instructions`. Blank instructions are ignored. The profile must already provide `systemPrompt` (`dsh-base` does).

`type: "mcp"` tools mount on that session only. HTTP needs an absolute `server_url` and may set `headers`. Stdio needs `command` and may set `args` and `env`. `credential_id` and `connection_origin: "service"` are rejected. The MCP client package loads only when the session declares MCP tools.

### Host tool catalog and masks

`GET /health` is registered on the webserver outside `/v1` and returns `{ ok: true, service: "agents-api" }`.

Session create accepts `environment.type` `local` with an absolute `workspace_directory` (same cwd as `self_hosted`). `environment.type` `sandbox` returns an error; there is no sandbox. Omitting the environment, or sending `none`, stores a local workspace. `self_hosted` and `openai_hosted` stay as before. `AGENTS_API_WORKSPACES` supplies the cwd when the request does not pass an absolute directory. Deleting a session deletes environments whose `session_id` is that session.

SSE events include an `id:` line. `GET .../events` with `Last-Event-ID` replays newer buffered events, then continues live.

`GET /agents/tools` returns the live Host profile catalog from `ctx.tools.schemas()` (not wire function tools). The DSH extension field `host_tools: { allow?: string[], deny?: string[] }` on create/update agent or session `agent` overlays maps to `agentCtx.tools.restrict()` at session create: omit or `null` keeps every Host tool; `deny` hides named Host tools; `allow` keeps only those names; both may combine under Host intersect rules. Empty `host_tools: {}` is rejected. Unknown names fail when restrict runs. Wire `agent.tools` stay additive and are not removed by `host_tools`.

### Host scheduler key (`prepare` failures)

Wire function calls run through the Host tool pipeline. That pipeline looks up `@deepseek-ai/dsh-tools`'s internal scheduler with `TOOL_RUNTIME_SCHEDULER`. The key is `Symbol.for('@deepseek-ai/dsh-tools.scheduler')` so a `pnpm dsh` source-launch `src` copy and a profile-resolved `lib` copy share one identity. A per-module `Symbol(...)` key makes `ctx.tools[TOOL_RUNTIME_SCHEDULER]` undefined when both copies load; the session then fails with `Cannot read properties of undefined (reading 'prepare')` after the function-call item is logged. That failure is a Host tools identity bug, not a missing `tool_result`. Restart the Host after rebuilding or updating `@deepseek-ai/dsh-tools` so both planes pick up `Symbol.for`.

