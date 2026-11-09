# Agents API HTTP routes

Route and wire detail for `@agentry/api`. Install and profile composition live in the [package README](../README.md).

## Official routes

Requests should send `OpenAI-Beta: agents=v1`. Paths below are relative to the configured `prefix` (default `/v1`).

| Method | Path | Role |
|---|---|---|
| `POST` `GET` | `/agents` | Create or list saved agents |
| `GET` | `/agents/tools` | List Host profile tools. `?session_id=` keeps only that session's `host_tools` mask; omit it for the full catalog |
| `POST` `GET` | `/agents/environments/templates` | Create or list environment templates |
| `GET` `POST` `DELETE` | `/agents/environments/templates/{id}` | Retrieve, update, or delete one template |
| `POST` `GET` | `/agents/environments` | Create or list environments. Each is a local directory `<workspaces>/<owner>/<environment_id>/` with `provider: "local"` |
| `GET` `DELETE` | `/agents/environments/{id}` | Retrieve (status `failed` when the directory is gone) or delete one environment and its directory |
| `POST` `GET` | `/agents/environments/{id}/files` | Write or list files in the environment workspace |
| `GET` | `/agents/environments/{id}/files/{path}` | Read one environment file |
| `GET` `POST` `DELETE` | `/agents/{agent_id}` | Retrieve, update, or delete a saved agent |
| `POST` `GET` | `/agents/sessions` | Create or list sessions (`agent` object and/or `agent_id`). The list is newest first; `order` is ignored |
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

## Authentication errors

Every route under the prefix needs `Authorization: Bearer <token>`. The token is a Keycloak access token (`production`), an Agentry API key `agk_…` (`apiKeys`; hashes in config, see the README), or the development key (`development`). A missing or invalid credential returns 401 with error code `unauthenticated` and `WWW-Authenticate: Bearer`. A principal holding neither `agentry-user` nor `agentry-admin` returns 403 with error code `forbidden`. `/health` is unauthenticated.

## Owner scoping and store errors

Agents, templates, environments, and sessions belong to the authenticated owner. Every read, update, delete, and list sees only the caller's records; another owner's id answers 404 `resource_not_found`, as an unknown id does. A `template_id` or `session_id` of another owner on `POST /agents/environments` answers 400.

While the Postgres store is opening, after it failed to start, or when a database call fails, routes answer 503:

```json
{ "error": { "type": "server_error", "message": "agents store unavailable: …", "code": "store_unavailable" } }
```

## Session create and follow-up

`POST /agents/sessions` accepts `input` as a string or `input_text` messages and `stream: true` for SSE on the create response. Follow-ups use `agent.session.input.message`. Steering vs a new turn follows Host idle vs in-progress. Cancel uses `agent.session.input.cancel`.

### Changing model and reasoning effort

`POST /agents/sessions/{id}` and `agent.session.input.message` change the live agent. The change applies from the next model step; a step already streaming finishes with the old route. These wire fields work live:

| Where | Fields |
| --- | --- |
| `POST /agents/sessions/{id}` | `agent.model`, `agent.reasoning.effort` |
| `agent.session.input.message` | optional `model`, optional `reasoning.effort`, applied before the message is queued |

`agent.session.input.message` accepts the same two fields as top-level keys next to `input`:

```json
{ "type": "agent.session.input.message", "input": "…", "model": "deepseek-reasoner", "reasoning": { "effort": "high" } }
```

The agent always receives a complete selection built from the stored session settings plus the change: an effort alone keeps the session's model, a model alone keeps the session's stored effort. `service_tier` and `metadata` are stored without touching the agent. A change is validated against the provider before anything is stored. If the model or effort is unsupported, the session is not running and cannot be resumed, or the agent rejects the selection, the answer is 409 `session_setting_not_live` and nothing changes (for a message, nothing is queued). `reasoning.effort` on session create is passed to the agent as well; an unsupported effort answers 400.

## Approvals and user questions

A sandbox escalation, a tool that needs approval, or an `ask_user_question` call parks the turn. The session status becomes `requires_action` and `required_actions` gains an `approval` entry next to any parked function calls:

```json
{
  "type": "approval",
  "id": "5b1f…",
  "kind": "tool_approval",
  "prompt": "Approve bash",
  "options": ["approve", "deny"],
  "tool_name": "bash",
  "call_id": "call_1"
}
```

- `kind` is `sandbox_escalation` (the request widens the sandbox mode), `tool_approval` (any other approval), or `user_question`.
- `tool_name` and `call_id` are present for approvals when the Host knows them. For `user_question`, `options` holds the option labels when exactly one question was asked; `questions` carries the full question items (`id`, `question`, `options`, `multiSelect`, `intent`, …) for several questions.
- For approvals `id` is the id the Host logs in `approval/asked`, so it is stable across SSE replay. For questions it is the tool `call_id` or a generated `appr_…` id.
- `agent.session.requires_action` is sent as an ephemeral event (no `id:`, not replayed) when an approval appears; a reconnecting client reads `required_actions` from the status snapshot. When the last pending action clears, an ephemeral `agent.session.in_progress` follows.

Answer with `POST /agents/sessions/{id}/events`:

```json
{ "type": "agent.session.input.approval_response", "id": "5b1f…", "decision": "approve" }
```

| Request | `decision` | Result |
| --- | --- | --- |
| approval | `approve` | allowed once |
| approval | `deny` | rejected |
| question | `answer` with `payload` | the answer; `{ "selected": ["A"], "custom": "…" }` for one question, `{ "answers": [{ "id", "selected", "custom"? }] }` covering every question |
| question | `deny` | skipped (empty `selected` for every question) |

Errors: 400 `invalid_approval_response` (bad `id` or `decision`, or an incomplete or malformed `answer` payload); 400 `decision_not_applicable` (`answer` on an approval, `approve` on a question); 404 `approval_not_found` (unknown id, already answered, or cancelled by `agent.session.input.cancel`, a session delete, the end of the turn, or a server restart). Another owner's session answers 404 `resource_not_found`.

Limits:

- Approvals requested by a subagent (child agent) are not exposed; they fail closed (the tool call is denied).
- Timed questions (`tool-ask-user` in `mode: "timed"`) are not supported; the Host continues without an answer.
- The profile must mount `tool-ask-user` for questions and keep the approval policy `ask`: under `never` (`DSH_PERMISSION_MODE=danger-full-access`) the Host rejects every approval before this API sees it.

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

Session create accepts `environment.type` `local` with an absolute `workspace_directory` (same cwd as `self_hosted`). `environment.type` `sandbox` returns an error; there is no sandbox. Omitting the environment, or sending `none`, stores a local workspace. `self_hosted` and `openai_hosted` stay as before. The configured `workspaces` root supplies the cwd when the request does not pass an absolute directory. Deleting a session deletes environments whose `session_id` is that session.

### Event ids and replay

Every event derived from the session's DSH Session log carries `id: <n>`, the 1-based position of the event in the session's wire event sequence. `agent.session.created` is always `id: 1`. The sequence is a pure function of the Session log, so a client's `Last-Event-ID` stays valid across server restarts. Event ids in the payload are deterministic too (`evt_<session_id>_<n>`), as are turn ids (`turn_<log position of turn/start>`) and item ids.

`GET .../events` with `Last-Event-ID: n` writes every event with a greater `id`, derived from the Session log, then continues live without gaps or duplicates. Without the header the stream starts live with one status snapshot event whose type matches the session status: `agent.session.idle`, `in_progress`, `requires_action`, or `failed` (also for an `interrupted` session). A non-numeric `Last-Event-ID` replays the whole history.

Three kinds of event are ephemeral: they have no `id:` line, are never replayed, and do not move later ids. They are the status snapshot written when a stream connects, the `idle` event that closes a streamed create without input, and `error` events for a failed input dispatch. A reconnecting client derives the current status from the snapshot.

A turn that was open when the server stopped is closed after the restart: its `function_call` tool calls get a failed `function_call_output`, and the turn becomes `cancelled` with `error.code: "interrupted"`. A `tool_result` for a call parked before the restart answers 400 `unknown_call_id`. Cancel now reports `agent.session.turn.cancelled` when the Host ends the turn, a few milliseconds after the request, rather than inside the request.

Known gap: the `session` objects inside replayed events show the session's current configuration, not the configuration at the time of the event, because configuration changes are not in the Session log. Subagent turns and items are in memory only and are lost on restart.

MCP tool `headers` supplied in `agent.tools` (which may carry credentials) are stored as part of the agent and session configuration in Postgres (`agents.body`, `sessions.body`) at rest.

A session that is not live after a restart is resumed from its Session log when an input event is posted to it. A session created before migration 0002 has no stored setup and answers 409 `session_not_resumable`; a resume failure answers 500 `session_resume_failed`.

`GET /agents/tools` returns the live Host profile catalog from `ctx.tools.schemas()` (not wire function tools). The DSH extension field `host_tools: { allow?: string[], deny?: string[] }` on create/update agent or session `agent` overlays maps to `agentCtx.tools.restrict()` at session create: omit or `null` keeps every Host tool; `deny` hides named Host tools; `allow` keeps only those names; both may combine under Host intersect rules. Empty `host_tools: {}` is rejected. Unknown names fail when restrict runs. Wire `agent.tools` stay additive and are not removed by `host_tools`.

### Host scheduler key (`prepare` failures)

Wire function calls run through the Host tool pipeline. That pipeline looks up `@deepseek-ai/dsh-tools`'s internal scheduler with `TOOL_RUNTIME_SCHEDULER`. The key is `Symbol.for('@deepseek-ai/dsh-tools.scheduler')` so a `pnpm dsh` source-launch `src` copy and a profile-resolved `lib` copy share one identity. A per-module `Symbol(...)` key makes `ctx.tools[TOOL_RUNTIME_SCHEDULER]` undefined when both copies load; the session then fails with `Cannot read properties of undefined (reading 'prepare')` after the function-call item is logged. That failure is a Host tools identity bug, not a missing `tool_result`. Restart the Host after rebuilding or updating `@deepseek-ai/dsh-tools` so both planes pick up `Symbol.for`.

