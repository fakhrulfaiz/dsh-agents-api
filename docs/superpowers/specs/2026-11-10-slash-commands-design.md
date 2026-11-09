# Slash-command menu (`/`) design

Status: draft for review, 2026-11-10. No code. DSH evidence paths are relative to `~/code/dsh-pinned/packages/`; Agentry paths are relative to `~/code/dsh-agents-api` (API) or `~/code/agentry-web` (web).

## 1. Goal and scope

One `/` menu in the composer with three groups, in this order: **Commands** (DSH, run on the backend), **App** (frontend only), **Skills** (insert `/name `). Today the menu lists skills only (`agentry-web/src/ui/chat/Composer.tsx:140-160`, `src/skills/skills-store.ts`).

## 2. DSH facts (verified)

- Registry: `CommandRuntime` (`interaction/commands/src/index.ts:263`) is a Remote service. `list(agent)` returns name-sorted `CommandDescriptor[]` after scoped shadowing (`:314-320`); `execute(agent, line, attachments, signal)` parses, runs the handler, returns `CommandExecution | undefined` (`:360-431`). `undefined` means bad syntax or unknown name (`:367-370`), and nothing is logged.
- Descriptor fields: `name`, `description`, optional `input.hint`, `input.attachments`, `definitionId` (`interaction/commands/src/types.ts:19-31,56-66`). Name grammar `^[a-z][a-z0-9_-]*$` (`index.ts:32`); a line parses as `/name` plus verbatim rest (`:125-132`).
- Arguments are one free-form string (`rawInput`, `index.ts:41-47`); each handler owns its grammar. `/compact` takes none and returns a usage error otherwise (`compaction/command-compact/src/index.ts:63-64`). `/goal` takes empty (show), `clear|pause|resume`, `edit <objective>`, or `<objective>` (`goal/command-goal/src/index.ts:35-44`). `/feedback <text>` requires text (`feedback/command-feedback/src/index.ts:74-77,123`).
- Result: `{kind:'success', text?, sourceEventSeq?} | {kind:'error', text}` (`types.ts:34-41`). Expected failures are error results; a thrown handler rejects the call and logs `command/done` as error (`index.ts:426-429,434-443`).
- Log: `command/run {commandId,name,args?,source}` and `command/done {commandId,kind,text?}` are log-only session events appended directly, with no turn (`types.ts:105-117`; `index.ts:373-378,451-467`).
- Scope: global definitions plus per-agent shadows (`index.ts:258-262,469-472`). Base mounts `commands` and `command-feedback` globally and `command-goal`/`command-compact` (`bundle/base/cordis.patch.yml:321-325,333-334,360-361`); the web-app bundle disables the last two globally (`bundle/web-app/cordis.patch.yml:530-531,549-550`) and each preset mounts them per agent (`bundle/web-app/presets/standard.patch.yml:44-45,78-79`; `minimal.patch.yml:32-33` mounts `/compact` only). So the catalog depends on the session's preset; `/goal` is absent in `minimal`.
- Change signals: `commands/change` (`types.ts:81-91`) and `agent-preset/selected` (`client/ui-commands/src/client/service.ts:125-129`).
- DSH web client: lists with `remote.commands.list(sessionId)` (`service.ts:108`), runs with `remote.commands.execute(sessionId, line, [])` (`api/session-controller/src/client/sessions/session.ts:411`); outcomes render as durable flow nodes, not a response echo (`session.ts:403-408`). The `/` source is registered in `service.ts:115-124`.
- Turn relation: commands run **outside a turn** (no turn wraps the log appends, `index.ts:451-456`), never reach the model, and the executor does not gate on turn state (`index.ts:360-431`). `/compact` self-gates with an error when the agent is not idle (`command-compact/src/index.ts:26-29`). The DSH SDK never falls back to a prompt when a recognized command fails (`sdk/server/src/server.ts:292-295`).
- Skill invocation: `tool-skill` scans only `source.kind === 'user'` text blocks for whitespace-bounded `/name` tokens, grammar `[a-z0-9]+(-[a-z0-9]+)*`, anywhere in the text (`skill/tool-skill/src/index.ts:423-444`, regex `:430`). Each token naming a user-invocable skill gets its body injected as instructions at `agent/pre-step`, and unknown tokens stay prose (`:167-205`). Note the comment at `:167-168` says "first line"; the code scans every text block, so `/name` mid-message also works. Claimed commands are resolved client-side first (`:177-178`).

## 3. Backend design: DSH commands

### 3.1 List: `GET /v1/agents/commands?session_id=`

- Response `{object:'list', data:[{name, description, input_hint?, accepts_attachments}]}`. `definitionId` stays internal.
- Resolution: `session_id` owned by the caller (else 404, same as skills, `src/skills.ts` `notFound`). `AgentsGateway.agentFor(sessionId)` already resolves/resumes the live agent (`src/gateway.ts:1136-1146`); call `ctx.commands.list(agent)`.
- No `session_id`: return `data: []`. Preset-scoped commands need an agent, and `/feedback` needs a session. The new-chat page shows App and Skills groups only.
- Missing `commands` service (profile without `dsh-commands`): `data: []`, not an error.

### 3.2 Run: recommend `POST /v1/agents/sessions/{id}/commands/{name}`

Body `{input?: string}` (the verbatim text after the name). Server builds `/{name}{input ? ' ' + input : ''}` and calls `commands.execute(agent, line, [], signal)`. Response 200 `{command_id, name, status:'success'|'error', text?, item}`; `item` is the new chat item (3.4).

Why a route and not `agent.session.input.command`:
1. `POST .../events` is a fire-and-queue channel for model-visible inputs (`src/gateway.ts:856-905`, `src/types.ts:437-470`). A command needs a synchronous result and error mapping (`execute` returns the outcome, `index.ts:430`); a batch event returns nothing per event.
2. Commands never reach the model (`index.ts:76` handler doc; `session.ts:403`), so they do not belong on the input-event union that feeds turns. Mixing them in a batch also invites ordering questions with `message` events.
3. A resource route gives a distinct 404 (unknown command) and 409 (busy), plus an `AbortSignal` from the request close.
4. Cost: one more route, one OpenAPI path. Accepted.

Unknown name: `execute` returns `undefined` -> 404 `command_not_found`. Attachments: v1 passes `[]`; a command with `accepts_attachments` still works text-only (`/goal` rejects attachments, `command-goal/src/index.ts:118`).

### 3.3 Checks and conflicts

- Owner: `store.sessions.get(id, owner)` as in `postEvents` (`gateway.ts:857-862`); other owner -> 404.
- Resume: `ensureLive(row)`; `session_not_resumable` -> 409 existing code (`gateway.ts:1110-1121`).
- Running turn: if projector status is `in_progress` or `requires_action` (statuses used at `gateway.ts:1678`), answer **409 `session_busy`** before calling `execute`. Reason: handlers mutate agent state (`/goal` create, `/compact` replaces history) and the executor does not serialise against a running turn (`index.ts:360-431`). `/compact` already errors itself when busy, but 409 gives a uniform, non-logged failure.
- Handler `error` result: HTTP 200 with `status:'error'` (an expected outcome, logged by DSH as `command/done` error, `index.ts:379-388`). A thrown handler -> 500 `command_failed`.
- Client disconnect aborts the signal; DSH settles the log as error (`index.ts:426-429`).

### 3.4 Result in chat

`command/run`/`command/done` are log-only, so `src/items.ts` (event fold at `:96-210`) must pair them by `commandId` into one item:
`{id:'item_cmd_<seq>', type:'slash_command', command_id, name, args?, status:'completed'|'failed', text?, turn_id}`. Do not reuse `command_execution`: it means a shell tool call (`items.ts:162`). Items outside a turn: `turn_id` becomes nullable, or the item attaches to the next turn; see open question 2. The item is replayed from the Session log, so history and SSE replay show it after reload (model-visible rule is moot; this is human-only output). SSE: emit `item.created`/`item.completed` through the existing projector path for live clients.

### 3.5 OpenAPI and docs

`openapi/agentry.yaml`: add `/v1/agents/commands` (GET, `ETag`/`304`, 404, 503) next to `/v1/agents/skills` (`:132`), and `/v1/agents/sessions/{session_id}/commands/{name}` (POST; 200, 404, 409, 500); schemas `AgentCommand`, `AgentCommandList`, `CommandRunRequest`, `CommandRunResponse`, `SlashCommandItem` added to the item union. `tests/openapi-drift.spec.ts` and `openapi-contract.spec.ts` already enforce route-table parity. Update `AGENTS.md` backlog, `CHANGELOG.md`, `docs/changes/2026-11-10-slash-commands.md`, `docs/README.md` row (changelog rule).

## 4. Caching and speed

Reuse the skills pattern (`src/skills.ts:46-50,67-80`): in-memory per `(scope key)` with TTL (`commands.cacheTtlSeconds`, default 60, validated like `skills.cacheTtlSeconds`, `src/index.ts:203,225-226`), strong `ETag`, `Cache-Control: private, max-age=0, must-revalidate`, `If-None-Match` -> 304 via `matchesEtag`, in-flight de-duplication. Key by session id (agent scope differs per preset). Invalidate on `commands/change` and `agent-preset/selected`, and drop the entry when the session is deleted. Listing is a synchronous in-memory read (`index.ts:314`), so the TTL mainly saves resume cost; if a session is not live, serve a cold list only after `ensureLive` (open question 3).

Frontend: one store per session, mirroring `skills-store.ts` (60 s throttle, refresh on focus, failure keeps the previous list). Prefetch on chat open and on chat switch, never on keystroke. Filtering is client-side over the three loaded lists.

## 5. Frontend design

### 5.1 Menu UX
- Opens when `/` is typed as the first character (existing rule, `Composer.tsx:~156`); a later `/` is text. Group headers: "Commands", "App", "Skills" (sentence case; skip empty groups).
- Filter: case-insensitive, name prefix first, then substring, then description; headers hide when empty; "No matching command" empty state.
- Keyboard: up/down move across groups, Enter/Tab select, Esc closes, typing continues filtering. Enter on a highlighted row with no args needed runs it; rows with `input_hint` insert `/name ` and wait for text.
- Row: `/name`, supporting text = description, dim `input_hint` on the right. Name collisions (command vs skill vs app): command wins, then app, skill hidden. DSH resolves commands before skills the same way (`tool-skill/src/index.ts:177-178`).
- Submit routing in `Composer.submit`: parse the first token; DSH command -> `api.runCommand`; app command -> local handler; anything else (including skills) -> normal message.

### 5.2 App commands
- `/new` and `/clear`: both open a new chat (route to NewChat). The old chat stays in the sidebar; nothing is deleted. `/new <text>` starts the new chat with `<text>` as the first message. `/clear` is an alias; wording in the row: "Start a new chat".
- `/model [id]`: no arg opens the model menu; with an id applies it. In an open chat apply through `POST /v1/agents/sessions/{id}` (`gateway.ts:727-760`; 409 `session_setting_not_live` on failure); in a new chat set the pending model. Unknown id -> inline notice, no send.
- `/effort [low|medium|high|auto]`: same paths as `/model`. `auto` clears the choice and is never sent (`chat-settings.ts:31`).
- `/rename <title>`: **deferred**. The API has no session title field (no `title` handling in `src/gateway.ts`); needs a backend change first.
- App commands never go to the model, never enter history, and their feedback is a transient toast/notice (`Notice.tsx`).

### 5.3 Skills
`GET /v1/agents/skills?session_id=` with `session_id` in an open chat; reload on chat change (key the store by session id; today `api.listSkills()` takes no argument, `src/api/client.ts:273`). Selecting a skill inserts `/name ` (`Composer.tsx` `onSelect`). Sent as an ordinary message: `tool-skill` finds the token (`index.ts:430`) and injects the skill body for that step (`:190-203`). No backend change.

## 6. Error cases

| Case | Behavior |
|---|---|
| Commands list fails (503/network) | Keep previous list; Commands group hidden, no error toast; App and Skills still work |
| Run 409 `session_busy` | Inline notice "Wait for the current turn to finish"; keep the typed text |
| Run 404 `command_not_found` (stale catalog) | Refresh list, notice, keep text |
| Run 200 `status:'error'` | Render the item with the error text; clear the input |
| Run 5xx / network | Keep text, show the error, allow retry (same as `submit` catch, `Composer.tsx`) |
| Session not resumable (409) | Existing session error banner |
| Preset lacks a command | It is simply absent from the list |

## 7. Tasks

Backend (repo `dsh-agents-api`):
- **B1 Commands catalog route** (Sonnet). Files: new `src/commands.ts` (mirror `src/skills.ts`), `src/gateway.ts` (route before `/agents/:agent_id`, near `:229`), `src/index.ts` (`commands.cacheTtlSeconds`). Tests: new `tests/commands.spec.ts` (200, 304, 404 foreign session, empty without session, TTL, invalidate on `commands/change`).
- **B2 Command run route + 409 gate** (Opus: owner, resume, busy race, abort, error mapping). Files: `src/commands.ts`, `src/gateway.ts` (`agentFor`, projector status). Tests: `tests/commands.spec.ts` (success, error result, unknown 404, busy 409, other owner 404, thrown handler 500).
- **B3 `slash_command` item from `command/run`+`command/done`** (Opus: pairing, replay, nullable `turn_id`). Files: `src/items.ts`, `src/types.ts`, `src/sse.ts`. Tests: `tests/items.spec.ts`, `tests/gateway-history.spec.ts` (history replay after restart).
- **B4 OpenAPI + docs** (Sonnet). Files: `openapi/agentry.yaml`, `CHANGELOG.md`, `docs/changes/2026-11-10-slash-commands.md`, `docs/README.md`, `AGENTS.md`. Tests: `tests/openapi-drift.spec.ts`, `tests/openapi-contract.spec.ts`.
- **B5 Profile check** (Sonnet). Verify `agentry` profile mounts `dsh-commands` and presets; `tests/loader-composition.spec.ts` asserts `/compact`, `/goal`, `/feedback` list for the default preset.

Frontend (repo `agentry-web`, after B1-B4 land):
- **F1 API client + types** (Sonnet). Files: `src/api/client.ts` (`listCommands`, `runCommand`, `listSkills(sessionId)`), generated/hand types. Tests: client unit tests with ETag/304.
- **F2 Per-session menu stores** (Sonnet). Files: `src/skills/skills-store.ts` (key by session), new `src/commands/commands-store.ts`, `src/commands/app-commands.ts`. Tests: store refresh, chat-change reload, failure keeps list.
- **F3 Grouped menu + keyboard + filtering** (Opus: Astryx trigger API may lack group headers; may need a custom renderer). Files: `src/ui/chat/Composer.tsx`. Tests: component tests for grouping, filter ranking, Enter/Tab/Esc, collisions.
- **F4 Submit routing and app-command behavior** (Opus: send/steer races, model/effort persistence). Files: `Composer.tsx`, `NewChat.tsx`, `Conversation.tsx`, `chat-settings.ts`. Tests: `/new`, `/clear`, `/model`, `/effort`, command run 409/404 paths.
- **F5 Render `slash_command` item** (Sonnet). Files: `src/ui/chat/Message.tsx` or a new `CommandResult.tsx`, `src/chat/` reducer. Tests: success/error render, replay.

## 8. Resolved (2026-11-10)

1. Commands are blocked during a running turn: 409 `session_busy`, and the menu greys them out while a turn runs. Safe in-turn commands come later.
2. A result produced between turns is its own item with `turn_id: null`; it is not attached to a turn.
3. For a non-live session, the list serves the default preset's command catalog without resuming; the session is resumed only when a command runs.
4. `/rename` is frontend-only: it opens the existing Rename dialog (sessions already have `metadata.title`); no backend work.
