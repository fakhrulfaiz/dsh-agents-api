# Agents API HTTP routes

Route and wire detail for `@deepseek-ai/dsh-experimental-agents-api`. Install and profile composition live in the [package README](../README.md).

## Official routes

Requests should send `OpenAI-Beta: agents=v1`. Paths below are relative to the configured `prefix` (default `/v1`).

| Method | Path | Role |
|---|---|---|
| `POST` `GET` | `/agents` | Create or list saved agents |
| `GET` | `/agents/tools` | List Host profile tools (`name` / `description` / `parameters`, `source: "host"`) |
| `GET` `POST` `DELETE` | `/agents/{agent_id}` | Retrieve, update, or delete a saved agent |
| `POST` `GET` | `/agents/sessions` | Create or list sessions (`agent` object and/or `agent_id`) |
| `GET` `POST` `DELETE` | `/agents/sessions/{session_id}` | Retrieve, update (`model` / `reasoning.effort` / `service_tier` / `metadata`), or delete |
| `POST` `GET` | `/agents/sessions/{session_id}/events` | Submit input events; `GET` is the SSE stream (`?stream=true`) |
| `GET` | `/agents/sessions/{session_id}/items` | List saved items (`order=asc` by default) |
| `GET` | `/agents/sessions/{session_id}/turns` | List turns |
| `GET` | `/agents/sessions/{session_id}/turns/{turn_id}` | Retrieve one turn |

## Session create and follow-up

`POST /agents/sessions` accepts `input` as a string or `input_text` messages and `stream: true` for SSE on the create response. Follow-ups use `agent.session.input.message`. Steering vs a new turn follows Host idle vs in-progress. Cancel uses `agent.session.input.cancel`.

## Function tools

1. Create a session with `agent.tools: [{ type: "function", name, description?, parameters? }]`.
2. Stream until `agent.session.requires_action` (or read `session.required_actions`).
3. Post `agent.session.input.tool_result` with `turn_id`, `call_id`, and either `success: true` + `output` or `success: false` + `error`.
4. Legacy alias: `agent.session.input.function_call_output` maps to a successful completion.

Harness profile tools remain available and stack with wire functions. A same-name scoped wire tool shadows the profile global for that session. MCP, `web_search`, `programmatic_tool_calling`, `tool_search`, and `defer_loading` are rejected at create time.

### Host tool catalog and masks

`GET /agents/tools` returns the live Host profile catalog from `ctx.tools.schemas()` (not wire function tools). The DSH extension field `host_tools: { allow?: string[], deny?: string[] }` on create/update agent or session `agent` overlays maps to `agentCtx.tools.restrict()` at session create: omit or `null` keeps every Host tool; `deny` hides named Host tools; `allow` keeps only those names; both may combine under Host intersect rules. Empty `host_tools: {}` is rejected. Unknown names fail when restrict runs. Wire `agent.tools` stay additive and are not removed by `host_tools`.

### Host scheduler key (`prepare` failures)

Wire function calls run through the Host tool pipeline. That pipeline looks up `@deepseek-ai/dsh-tools`'s internal scheduler with `TOOL_RUNTIME_SCHEDULER`. The key is `Symbol.for('@deepseek-ai/dsh-tools.scheduler')` so a `pnpm dsh` source-launch `src` copy and a profile-resolved `lib` copy share one identity. A per-module `Symbol(...)` key makes `ctx.tools[TOOL_RUNTIME_SCHEDULER]` undefined when both copies load; the session then fails with `Cannot read properties of undefined (reading 'prepare')` after the function-call item is logged. That failure is a Host tools identity bug, not a missing `tool_result`. Restart the Host after rebuilding or updating `@deepseek-ai/dsh-tools` so both planes pick up `Symbol.for`.

## Related notes

- [Mount wire function tools](changes/2026-09-18-mount-function-tools.md) — parked Host execute and `tool_result` decision.
- [Host tool catalog and restrict](changes/2026-09-18-host-tools-catalog.md) — `GET /agents/tools` and `host_tools` allow/deny.
- [Host tool scheduler Symbol identity](changes/2026-09-18-tool-scheduler-symbol.md) — `prepare` failure when `src` and `lib` disagree on the scheduler key.
- [Package change index](README.md) — other durable change notes.
