# Changelog

All notable changes to `@agentry/api` are recorded here.
Detailed write-ups live under [`docs/changes/`](docs/changes/).

## 2026-11-10 — Bundled office runtime

- `cordis.patch.yml` mounts `@deepseek-ai/dsh-tool-workspace-dependencies` from a prebuilt payload (`AGENTRY_OFFICE_RUNTIME`, default `~/.dsh/office-runtime/primary-runtime`) and points `skill-office` at the sibling `office-skills`, so agents use the bundled Python instead of pip-installing libraries. Build it with `pnpm run prepare:primary-runtime --target linux-x64 --output ~/.dsh/office-runtime` in the DSH checkout.

## 2026-11-10 — Session deliverables

- `GET /v1/agents/sessions/{id}/deliverables` lists the files the agent declared with the DSH `present` tool (`path` made workspace-relative when inside the workspace, optional `description`, `turn_id`, `created_at`), read from the Session log and owner-scoped. `present` and its prompt guidance already come from the web-app bundle's presets, so `cordis.patch.yml` is unchanged. Use it instead of the artifact listing to show only delivered files; bytes still come from the artifacts content route.

## 2026-11-10 — Workspace and shell guidance

- Every agent session now gets a system-prompt rule: do not search the whole filesystem (`/`, `/mnt`, home-wide `find`), stay in the workspace, and use the matching office skill's own scripts for docx/pptx/xlsx. The shell executor already defaults to a 120s timeout (max 600s) in DSH, so no profile patch was needed.

## 2026-11-10 — File attachments (backend)

- `POST /v1/agents/files` (multipart upload, magic-byte sniffing, size and quota limits, traversal-safe names), `GET /v1/agents/files/{file_id}/content` (owner-checked, `nosniff`, sandbox CSP, rasters inline, everything else a download), `DELETE /v1/agents/files/{file_id}` (staged only).
- Messages on `POST /sessions` and `.../events` accept `input_image` / `input_file` parts with `file_id`. Each file is stored in the DSH attachment store, copied to `<workspace>/uploads/` without overwriting, and logged with a note; images reach the model as images only on routes that accept them. User message items carry the file parts, live and after a restart.
- Migration `0003-files.sql`; new `uploads` config block (off until `uploads.dir` is set); staged files expire after `uploads.stagedTtlMinutes`; `@deepseek-ai/dsh-attachment` is a new peer and `busboy` a new dependency. Write-up: [docs/changes/2026-11-10-attachments.md](docs/changes/2026-11-10-attachments.md).

## 2026-11-10 — Artifact download headers

- `GET /v1/agents/sessions/{id}/artifacts/{path}` now sends the `Content-Type` for the file extension (`application/octet-stream` for unknown ones, `; charset=utf-8` for text types), `Content-Disposition: inline; filename="..."` (`attachment` with `?download=1`), and `X-Content-Type-Options: nosniff`.

## 2026-11-10 — Slash commands

- `GET /v1/agents/commands?session_id=` lists Host commands (`name`, `description`, `input_hint`, `accepts_attachments`) for the `/` menu: the live agent's catalog, the default preset's catalog for a session that is not live (no resume), and an empty list without `session_id`. Cached per scope for `commands.cacheTtlSeconds` (default 60), dropped on `commands/change` and `agent-preset/selected`, strong `ETag` with `304`, `503 commands_unavailable` on a failed read. `@deepseek-ai/dsh-commands` is a new optional peer.
- `POST /v1/agents/sessions/{id}/commands/{name}` (`{ input? }`) runs a command outside any turn: `200` with `status` `success` or `error` plus the result `item`, `404 command_not_found`, `409 session_busy` while a turn or another command is running, `500 command_failed`. Closing the request aborts the command.
- `command/run` + `command/done` become one `slash_command` item (`turn_id: null` between turns) in items, history replay, and a new `agent.session.item.done` SSE event. Frame ids of sessions that already logged commands shift by one frame per command.
- Write-up: [docs/changes/2026-11-10-slash-commands.md](docs/changes/2026-11-10-slash-commands.md). Wire detail: [docs/http-api.md](docs/http-api.md#slash-commands). Spec: `docs/superpowers/specs/2026-11-10-slash-commands-design.md`.

## 2026-11-10 — ask_user_question stays untimed

- Checked live: with the shipped presets (`tool-ask-user` in blocking mode) a session that calls `ask_user_question` reaches `requires_action` with a `user_question` approval, so no bridge or profile change was needed. `tests/ask-user-mode.spec.ts` pins the default `mode: legacy`; a `mode: timed` row would bypass the bridge (`wait.timed` requests are delegated), so `timeout: -1` is not a fix for it.

## 2026-11-10 — Office skills in the profile

- `cordis.patch.yml` mounts `@deepseek-ai/dsh-skill-office` as a host-level row, so the seven Office skills (`office`, `office-docx`, `office-pptx`, `office-xlsx`, `office-render`, `office-recalculate`, `office-export-pdf`) appear in `GET /v1/agents/skills` and load by name through every preset's `tool-skill`.

## 2026-11-10 — Host tool catalog scope

- `GET /v1/agents/tools` leased the default preset scope through `standingKeyFor`, which the pinned DSH does not have, so the call fell back silently to the empty global registry. It now uses `agentPresets.acquireScope()` and releases the lease. `tests/host-tool-catalog.spec.ts` covers it.

## 2026-11-10 — Scheduled task hardening

- `DELETE /agents/sessions/{id}` stops the live agent before it deletes tasks, and deletes tasks that list the session in `involvedSessionIds` as well as those that target it. Pause, resume, and delete send the revision read for the ownership check as `expectedUpdatedAt` (409 `schedule_conflict` on a change). `schedule_cleanup_failed` and session-create 500s return generic messages and log the cause. Write-up: [docs/changes/2026-11-09-scheduled-tasks.md](docs/changes/2026-11-09-scheduled-tasks.md#hardening).

## 2026-11-10 — Skill catalog endpoint

- `GET /v1/agents/skills` lists skills (`name`, `description`, `source`) sorted by name from `ctx.skills.list({ scope, cwd })`, read at request time. Optional `?session_id=` (owned by the caller, else `404`) selects that session's live agent scope and workspace; without it the default preset scope and the owner's default workspace root apply, so preset and `~/.agents/skills` skills appear in the Agentry profile. Without the skill service it answers `200` with an empty list. Cached in memory per (scope, cwd) for `skills.cacheTtlSeconds` (default 60, `0` disables), concurrent misses share one call, strong `ETag` with `304` on `If-None-Match`, `503 skills_unavailable` on a failed load (not cached). Wire detail: [docs/http-api.md](docs/http-api.md#skill-catalog); `openapi/agentry.yaml` declares the operation. `@deepseek-ai/dsh-skill` is a new optional peer.

## 2026-11-10 — Scheduled tasks

Summary of the scheduled-task work below (routes, session resolution, history items, prompt guidance, `ownersOf`, `createIdleSession`). Write-up: [docs/changes/2026-11-09-scheduled-tasks.md](docs/changes/2026-11-09-scheduled-tasks.md). Wire detail: [docs/http-api.md](docs/http-api.md#scheduled-tasks).

- The `/v1/agents/schedules` contract is in `openapi/agentry.yaml` (9 operations; `ScheduleTiming` is a `oneOf` by `kind`) and the contract test validates every route.

## 2026-11-10 — Prompt guidance for chat-created scheduled tasks

- Sessions get an agent-scoped system-prompt section `agentry:schedule` (just after `tool:schedule`) that tells the model to create scheduled tasks with target `this_session` only and to use the time zone the user stated, asking when it is unknown. The text is empty at each assembly where `schedule_create` is not visible, including after `host_tools.deny: ["schedule_create"]`. `new` and `new_once` targets would create sessions the API cannot list or resume.

## 2026-11-10 — Scheduled prompts in the chat history

- A prompt a scheduled task delivers to a session now appears as a user message item with `source: "schedule"` (and `schedule_id` when one task delivered it) and `content` set to the task prompt instead of the Host framing. A reminder batch joins its prompts with a blank line; framing that cannot be parsed shows the full text. `[SCHEDULE CHANGE]` notices still produce no item. Live and replayed projections agree. `MessageItem` in `openapi/agentry.yaml` declares both fields.

## 2026-11-10 — Scheduled task routes

- New `/v1/agents/schedules` routes over the Host schedule service: create, list (`status`, `limit`, `after`), retrieve, update (`revision` guard), delete, pause, resume, run now, and `runs` (delivery history). Every route is owner scoped: a task belongs to the owner of its target session, else of the first involved session in the index, and another owner's task answers 404 `schedule_not_found` before any mutating call. A profile without the schedule service answers 501 `schedules_unavailable`.
- `POST /agents/schedules` creates a dedicated idle session for the task (or targets the caller's own `session_id`); a task the Host rejects deletes the session it created. New `AgentsGateway.discardSession(owner, id)` is the teardown `DELETE /agents/sessions/{id}` uses, without the HTTP layer.
- Host input errors answer 400 with the Host code; `schedule_conflict`, `schedule_execution_pending`, and `schedule_target_archived` answer 409. The routes are in `openapi/agentry.yaml`.

## 2026-11-10 — Scheduled deliveries resume Agentry sessions

- Scheduled-task deliveries (`schedule/resolve-agent`) to a session in the index resume it with its Agentry setup (instructions, function and MCP tools, host-tool mask) and register it for SSE and status writes; other session ids keep the Host resolver. A session without a stored setup fails the delivery with `session_not_resumable`. New `AgentsGateway.agentFor(sessionId)`.
- `DELETE /agents/sessions/{id}` first deletes the scheduled tasks that deliver to the session; when the schedule service cannot be read, it answers 500 `schedule_cleanup_failed` and keeps the session.
- Fix: concurrent lazy resumes of one session (events, settings, scheduled deliveries) share one `agents.resume`; before, a second caller during the log read started another.
- `@deepseek-ai/dsh-schedule` is an optional peer dependency; profiles without the schedule service still load. `GatewayOptions.schedule` is required (return `undefined` when absent).

## 2026-11-10 — Session provisioning without a request

- Internal: `AgentsGateway.createIdleSession(owner, params)` creates an idle session (agent resolution, workspace, agent, index row, no turn) through the same `provisionSession` path as `POST /agents/sessions`; a failed agent create undoes the registration and writes no row (`SessionCreateError`). Groundwork for scheduled tasks. No wire change.

## 2026-11-10 — Store: owners of many sessions

- Internal: `Store.sessions.ownersOf(ids)` returns the owner of each existing session id in one query (groundwork for scheduled tasks, see `docs/superpowers/specs/2026-11-09-scheduled-tasks-design.md`). No wire change.

## 2026-11-09 — OpenAPI contract

- Added `openapi/agentry.yaml` (OpenAPI 3.1) covering every `/v1` route and `/health` with request and response schemas derived from `src/types.ts`, the error envelope, bearer security, and the SSE stream (`text/event-stream`, deterministic `id:`, ephemeral frames, `Last-Event-ID`). Clients generate types with `openapi-typescript`.
- `AgentsGateway.routeTable()` lists the registered routes. `tests/openapi-drift.spec.ts` compares them with the spec; `tests/openapi-contract.spec.ts` validates recorded gateway responses, streamed events, and fixtures against the spec schemas (`ajv`). The admin API (`/admin/v1`) is not in the spec yet.
- See [docs/changes/2026-11-09-openapi-contract.md](docs/changes/2026-11-09-openapi-contract.md).

## 2026-11-09 — Approvals over the API, live model and effort

- Sandbox escalations, tool approvals, and `ask_user_question` calls become `approval` entries in `required_actions` (`kind` `sandbox_escalation`, `tool_approval`, or `user_question`; optional `tool_name`, `call_id`, `questions`). The session shows `requires_action` and answers with `agent.session.input.approval_response` (`approve`, `deny`, or `answer` with `payload`). Unknown, answered, or cancelled ids answer 404 `approval_not_found`; mismatched decisions answer 400.
- `agent.session.requires_action` and `agent.session.in_progress` for approvals are ephemeral events (no `id:`, not replayed). Cancel, session delete, the end of the turn, and a restart drop pending approvals.
- `POST /agents/sessions/{id}` now retargets the live agent for `agent.model` and `agent.reasoning.effort` (applies from the next model step). `agent.session.input.message` accepts optional `model` and `reasoning.effort`. An unsupported or non-live change answers 409 `session_setting_not_live` and stores nothing.
- Fix: `reasoning.effort` on session create is passed to the agent (it was stored but ignored); an unsupported effort answers 400.
- Limits: subagent approvals fail closed; timed questions are unsupported.
- Breaking: the profile must provide `llm`, `approval`, and `userQuestions`; peer dependencies `dsh-user-approval` and `dsh-user-questions` added. `GatewayOptions.approvals` is required.
- See [docs/changes/2026-11-09-approvals.md](docs/changes/2026-11-09-approvals.md).

## 2026-11-08 — History from the Session log, restart recovery, SSE replay

- Items, turns, and `GET .../events` replay are derived from the DSH Session log (`dsh-session-query`) instead of memory, so they survive restarts. Live and replay share one projector (`WireProjector`): turn ids are `turn_<log position>`, event ids are `evt_<session>_<n>`, and each frame's SSE `id:` is its position in the derived sequence. `Last-Event-ID` replays exactly the missed events, then continues live.
- Status snapshots on connect, the idle event of a streamed create without input, and dispatch `error` events are ephemeral: no `id:`, never replayed.
- Startup recovery: sessions that were `in_progress` or `requires_action` are resumed through `ctx.agents.resume`, or marked `interrupted` with `last_error`. A POST to a session that is not live resumes it lazily. The session status is written to the index wherever its wire event is produced, so `listResumable` is accurate.
- Migration `0002` adds `sessions.body jsonb`: the session's resolved agent, environment, metadata, and vault ids, needed to rebuild the agent on resume. Recovery is skipped (warning, rows untouched) when the agent factory is not registered yet. Rows created before it cannot be resumed (409 `session_not_resumable`; interrupted at startup).
- Cancel reports `agent.session.turn.cancelled` when the Host ends the turn. An open turn at a crash becomes `cancelled` with `error.code: "interrupted"`.
- Fixes: `GET /agents/sessions` is built from index rows only (`has_more` and `last_id` agree with `data`); `workspaces` is required by the gateway (no host-cwd fallback); `POST /agents/sessions/{id}` answers 404 when the session row is gone.
- Breaking: the profile must provide `sessionQuery` and `sessionPersistence`; peer dependencies `dsh-session-query` and `dsh-session-persistence` added.
- See [docs/changes/2026-11-08-durable-history.md](docs/changes/2026-11-08-durable-history.md).

## 2026-11-08 — apiKeys auth mode

- New `auth.mode: apiKeys` for simple self-hosting: named keys (`agk_` + 43 base64url characters) in `auth.apiKeys`, stored as `sha256:` hashes; with `auth.keycloak` also set, either credential works. `pnpm keys:create --name <n> --owner <o> [--admin]` prints a key once and its config entry.
- `production` rejects `apiKeys` entries and `devKey`; `development` rejects `apiKeys`.
- Breaking: `workspaces` is required (the OS temp-dir fallback and the `AGENTS_API_WORKSPACES` env var are removed); the bundled patch reads `AGENTRY_WORKSPACES`.
- Fix: `POST /agents/sessions/{id}` writes the session index before changing the live session, so a store failure answers 503 and leaves the session unchanged.
- See [docs/changes/2026-11-08-api-keys-mode.md](docs/changes/2026-11-08-api-keys-mode.md).

## 2026-11-08 — Postgres store

- Agents, environment templates, environments, and a session index live in Postgres (`Store`, `src/store/`); numbered forward-only migrations run at startup under an advisory lock. The JSON-file `durable-store.ts` is removed.
- Every `/v1` route is owner-scoped: another owner's record answers 404. `/v1` answers 503 `store_unavailable` while the store opens, after it failed to start (`StoreStartError` logged), and when a database call fails.
- Environment routes go through `EnvironmentProvider`; local environments live at `<workspaces>/<owner>/<environment_id>/` and default session workspaces at `<workspaces>/<owner>/<session_id>/`.
- Breaking: `database.url` is required (`AGENTRY_DATABASE_URL` in the bundled patch); `dataDir` and Codebox settings are rejected at load (`CodeboxDisabledError`). `GET /agents/sessions` is newest first and ignores `order`.
- See [docs/changes/2026-11-08-postgres-store.md](docs/changes/2026-11-08-postgres-store.md).

## 2026-11-08 — Keycloak authentication

- Replaced the single `apiKey` with an `auth` block: `production` verifies Keycloak JWTs (issuer, audience, JWKS), `development` accepts a fixed `devKey`. Owner is the token `sub`; roles come from `realm_access.roles`.
- 401 responses carry code `unauthenticated` and `WWW-Authenticate: Bearer`; 403 uses `forbidden`. The gateway passes the `Principal` to every route handler; owner filtering follows with the store.
- Breaking: `apiKey` is removed; `cordis.patch.yml` reads the development key from `AGENTRY_DEV_KEY`.
- See [docs/changes/2026-11-08-keycloak-auth.md](docs/changes/2026-11-08-keycloak-auth.md).

## 2026-11-08 — Standalone build

- Renamed the package to `@agentry/api` (was `@deepseek-ai/dsh-experimental-agents-api` / `@fakhrulfaiz/dsh-agents-api`).
- Standalone build against a pinned DSH tag: `dsh.pin`, `DSH_ROOT`, `pnpm check:dsh-pin`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Entry is the built `lib/index.js`; the tsx-only `src/entry.js` is removed.
- `typecheck`, `test`, and `build` run the pin check (also rejects tracked-file changes); `dsh:link` fails when DSH declarations are missing; DSH peer ranges are `>=0.2.2-rc.1`.
- Carried over the parked function-tools note: [docs/changes/2026-09-18-agents-api-parked-function-tools.md](docs/changes/2026-09-18-agents-api-parked-function-tools.md).

## 2026-09-18 — Agent changelog rule

- Add `AGENTS.md` and `.cursor/rules/changelog.mdc` so every shipped change updates `CHANGELOG.md` and `docs/changes/`.
- See [docs/changes/2026-09-18-agent-changelog-rule.md](docs/changes/2026-09-18-agent-changelog-rule.md).

## 2026-09-18 — Mount wire function tools

- Mount `agent.tools` entries of `type: "function"` as scoped Host tools.
- Park Host `execute` until the client posts `agent.session.input.tool_result` (legacy `function_call_output` accepted).
- Emit `agent.session.requires_action` and populate `required_actions`.
- Reject MCP / web_search / deferred function tools at create time.
- See [docs/changes/2026-09-18-mount-function-tools.md](docs/changes/2026-09-18-mount-function-tools.md).
