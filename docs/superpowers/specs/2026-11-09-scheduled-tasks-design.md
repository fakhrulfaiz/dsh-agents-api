# Scheduled tasks — design and plan

Date: 2026-11-09 · Status: awaiting user review · Scope: Agentry API (`/v1/agents/schedules`) and Agentry Web (`/scheduled`)

Repos: backend `~/code/dsh-agents-api` (`B*` tasks), frontend `~/code/agentry-web` (`F*` tasks). DSH reference: `~/code/dsh-pinned/packages/schedule/` (abbreviated `DSH:`). Decisions in [AGENTS.md](../../../AGENTS.md#decisions-do-not-re-litigate) are not repeated.

## 1. Findings (evidence)

### 1.1 DSH schedule service (question 1)

- Host-wide service `ctx.schedule` (`DSH:schedule/schedule/src/index.ts:224` `static inject = ['agents','sessions','storageDomain','sessionPersistence']`). The bundle `dsh-web-app` mounts it (`packages/bundle/web-app/cordis.patch.yml:135`) and the `standard`, `cordis`, `ptc` presets mount `dsh-tool-schedule` (`bundle/web-app/presets/standard.patch.yml:38`). The `agentry` profile (`dsh-base` + `dsh-web-app` + `@agentry/api`) therefore already has the service; `cordis.patch.yml` here adds nothing for it. Whether Agentry's default preset is one of the three must be confirmed (B0).
- Methods (`DSH:docs/subsystems/schedule.md:89-102`): `create(request, actorSessionId?, signal?)`, `list({active?,limit?,offset?})`, `catalog()`, `view({id})`, `history({id,limit,before?})`, `edit({id,action:'update'|'delete',patch,expectedUpdatedAt?})`, `run({id})`, `deleteInactive()`, `deliveryLimits()`. Pause/resume = `edit` with `patch.active=false|true`.
- Request (`types.ts` `ScheduleCreateRequest`): `{title (<=120), prompt, timing, target?}`. `timing` is a tagged union: `after{after_seconds}`, `at{at | {date,time,time_zone}}`, `every{every_seconds >= 60}`, `daily{time,time_zone}`, `weekly{time,time_zone,weekdays[1..7, Mon=1]}`, `cron{expression,time_zone}` (5 fields), `rrule{rrule}` (`DTSTART` + `RRULE`). Time zone must be an explicit IANA name (`invalid_time_zone`).
- Entry (`ScheduleCatalogEntry`): record fields per kind (`scheduledAt` = next occurrence, `time`, `timeZone`, `weekdays`, `expression`), plus `target`, `involvedSessionIds`, `status` (`active|paused|ended`), `createdAt`, `updatedAt` (the optimistic-lock revision), `executionActive`, `deliveryFloorEndsAt`, `lastDelivery{scheduledAt,deliveredAt,messageId,targetSessionId}`.
- Persistence: `storageDomain` `schedule` (JSON file `<DSH_HOME>/storages/schedule.json` or SQLite), loaded into memory at open (`README.md` "Storage format"). Tasks survive restarts; the Host must be running to deliver; after downtime a recurring task delivers only its latest missed occurrence (`README.md` Summary). Delivery history: 30 days / 200 receipts per task (`history()`).
- Errors: `ScheduleInputError` with `code` in `invalid_prompt|invalid_selector|invalid_rule|invalid_time_zone|not_future|time_out_of_range|frequency_too_high|subagent_session`; result codes `schedule_not_found`, `schedule_conflict`, `schedule_execution_pending` (`types.ts`); `RemoteError('schedule/target-archived')`.
- **Owner/tenancy: none.** Tasks are Host-wide; `schedule_list`/`schedule_view`/`schedule_edit` address any task by id, including ones "other Sessions created" (`DSH:tool-schedule/README.md` list tool). Agentry must add scoping itself.
- Timezone: stored per task; no Host default. The caller must send the zone. Local rules skip nonexistent wall times and take the earlier overlap (`schedule.md` "Recurrence rules").
- Minimum spacing: 60 s per task; `new` targets 60 s up to 1 week (`newSessionIntervalSeconds`).

### 1.2 Delivery (question 2)

- Targets (`schedule.md:76-84`): `session` (existing), `new_once` (reserve an id, create at first delivery, reuse), `new` (create per delivery). Delivery = `agent.inject(createUserMessage({source:{kind:'schedule'}}))` then `sessions.flush` (`runtime.ts:353`, `index.ts:723`). Reused-session tasks wait for the target agent to be idle.
- Activation: `activate()` runs the waterfall `schedule/resolve-agent` and falls back to `sessionController.resolveAgent` (`runtime.ts:464-466`, `index.ts:249`). The fallback resumes the session with **DSH defaults**: no Agentry `buildAgentSetup`, no wire function tools or instructions, no entry in `AgentsGateway.handles`/`SessionRegistry` (so no SSE or status writes). **Agentry must handle `schedule/resolve-agent`** and route it through `ensureLive` (`src/gateway.ts:958`, `resumeSession:925`). This also makes delivery to a non-live session work (lazy resume from the Session log, same path as `POST /events`).
- `new`/`new_once` creation calls `sessionController.create` (`runtime.ts:469-478`), which makes a DSH session with no Postgres index row, no owner, no `body` (not resumable by Agentry, invisible in the chat list). Agentry-created tasks therefore use only `session` targets (see 3.2).
- A delivered turn projects fine: the projector is log-driven (`turn/start` opens a turn, `src/history/projector.ts:172`). **Gap:** `itemsFromEvent` drops every `user/message` whose `source.kind !== 'user'` (`src/items.ts:32`), so the scheduled prompt would be invisible in the chat. B5 fixes it.
- Missed runs while the process is down: latest occurrence only, delivered after restart when the target resolves (`index.ts:249-253` `requestDrive` on provider ready). With B4 the resolver is Agentry's, which is ready once the gateway has its store attached.

### 1.3 Create from chat (question 3)

- The tools `schedule_create/list/view/edit` exist in the `standard`/`cordis`/`ptc` presets and are mounted by `mountDefaultPreset` (`src/gateway.ts:1566`) when the profile has `agentPresets`. `target: 'this_session'` resolves to `{kind:'session', sessionId: agent.session.id}` and the task records the actor as involved (`tool-schedule/src/index.ts:329-330,387`; `index.ts` create with `actorSessionId`).
- Ownership attribution without any new table: **a task belongs to the owner of its target session, else of the first involved session that has an index row.** For a chat-created task both are the chat's Postgres row. For tasks created over REST, Agentry creates the dedicated session itself (3.2). Lookup is one query (`sessions.ownersOf(ids)`, B1). No migration 0003 is needed.
- `new_once`/`new` from the tool would create orphan DSH sessions (1.2). The model chooses the target, so Agentry mounts a system-prompt section telling it to use `this_session` only (B6). The tool schema is fixed upstream; enforcement beyond the prompt is phase 2 (adoption, section 7).
- Cross-tenant exposure: the model tools list and edit **all** Host tasks (no owner). Acceptable under decision 5 (single user now; multi-user = one container per user). Stated as open question 2.

### 1.4 Backend facts used by the plan

- Routes: array in `AgentsGateway` constructor, `/agents/schedules*` must precede `/agents/:agent_id` (`gateway.ts:157-192`); `tests/openapi-drift.spec.ts` compares `routeTable()` with `openapi/agentry.yaml`; `tests/openapi-contract.spec.ts` validates responses. Owner scoping returns 404 for others' records (`requireSession`, `gateway.ts:592`).
- Create session logic is inline in `createSession` (`gateway.ts:414-556`): agent resolution, workspace, `agents.create`, `store.sessions.insert`. A schedule needs the same without HTTP or an initial turn (B2). An empty `input` already creates an idle session (`gateway.ts:545`).
- Plugin `inject` list at `src/index.ts:88` must add `schedule` (optional: absent service answers 501 `schedules_unavailable`).

### 1.5 Frontend facts used by the plan

- BFF allow-list `src/server/allowlist.ts:20-33` (+ `RESERVED_AGENT_IDS`, line 5); client `src/api/client.ts` (`request`, `seg`, `ApiError`); sidebar `src/ui/shell/Sidebar.tsx:190,206` (`SideNavItem` with `href`/`isSelected`); page pattern `app/(app)/settings/page.tsx` (`requirePageSession`, `TopBar`); `NewChat` creates a chat from the first message (`src/ui/chat/NewChat.tsx`).
- Astryx 0.7.11 (`pnpm exec astryx ...`): no schedule/cron/recurrence component. Use: `Table`/`TableRow`/`TableCell` (dense rows, "dense data = rows"), `TabList`/`Tab`, `EmptyState`, `DropdownMenu`/`DropdownMenuItem` (New task menu), `MoreMenu` (row actions), `Switch` (pause/resume), `Dialog`/`AlertDialog` (delete confirm), `FormLayout`, `Field`, `TextInput`, `TextArea`, `Selector`/`SelectorOption`, `SegmentedControl`, `ToggleButtonGroup` (weekdays), `TimeInput`, `DateInput`, `Timestamp`, `StatusDot`, `Banner`, `ClickableCard` (templates), `Typeahead` (time zone). Templates: `library` (Card Grid, Templates tab), `contact-form` (the `astryx build` answer for the form), `settings` (long sectioned form). Run `astryx component <Name>` for props before use and `astryx doctor --built` before delivery.

## 2. Decisions

1. **Ownership is derived, not stored** (1.3). `ownersOf` batch query; no migration. If derivation proves insufficient (e.g. per-run chats), add `schedules(id, owner_id)` as migration 0003 then.
2. **Tasks created over REST always target a dedicated Agentry session** (`session` target), created at task creation with `metadata {title, source:'schedule'}`, empty (no turn). It shows in the chat list; every run lands there. One chat per task (not per run) in v1.
3. **"Create with chat" is frontend-only**: opens a new chat with a seed message; the agent uses `schedule_create` with `this_session`. No dedicated endpoint (4).
4. **Templates are static frontend data** (5).
5. **Wire API passes DSH `timing` through unchanged** (tagged union, snake_case inputs) and echoes it in the same form on reads, so the form, API and DSH share one vocabulary. The UI's frequency pickers compile to it.
6. **Time zone is always sent by the client** (browser `Intl.DateTimeFormat().resolvedOptions().timeZone`, editable). The server never guesses.
7. **Optimistic concurrency** maps `expectedUpdatedAt` to a request field `revision` (= the entry's `updated_at`); mismatch answers 409 `schedule_conflict`.
8. **Schedule-sourced user messages become user items** with `source:'schedule'` and the extracted prompt text (B5). The log keeps the full framed text.

## 3. Answers

### 3.1 Create with Claude (question 4)
Recommend the frontend-only path. The seed message states the user's time zone and asks the agent to interview the user, then call `schedule_create(target:'this_session')` after explicit confirmation (the `tool:schedule` prompt section already demands user authorization, `tool-schedule/README.md` "User authorization"). Zero new backend; the task appears on `/scheduled` through ownership derivation. A dedicated endpoint (server-side NL parsing) would duplicate the agent loop and add a second model call path.

### 3.2 Manual create
`POST /agents/schedules` provisions a session (B2), then `ctx.schedule.create({title,prompt,timing,target:{kind:'session',sessionId}}, sessionId)`. If `create` is rejected, the provisioned session is deleted. With `session_id` in the body (own session only, else 404) the task targets that chat instead.

### 3.3 Templates (question 5)
Static list in the frontend (`src/schedule/templates.ts`): Daily briefing (weekdays 08:00), Weekly review (Fridays 16:00), Monitor a topic (daily 09:00), Content ideas (Mondays 09:00). A template carries `title`, `description`, `prompt`, and a `frequency` preset. "Use template" opens the form prefilled; the user's time zone is applied at use time. No backend endpoint (nothing per-owner, no persistence); admin-editable templates are a later spec.

## 4. API (question 6)

All under `/v1`, owner-scoped (another owner's id answers 404 `schedule_not_found`), error envelope as existing routes.

| Method | Route | Result |
|---|---|---|
| `POST` | `/agents/schedules` | `AgentSchedule` (200, like other creates) |
| `GET` | `/agents/schedules?status=&limit=&after=` | `{object:'list', data:[AgentSchedule], has_more, first_id, last_id}` (same list envelope as other collections) |
| `GET` | `/agents/schedules/{schedule_id}` | `AgentSchedule` |
| `POST` | `/agents/schedules/{schedule_id}` | update: any of `title, prompt, timing, revision` |
| `DELETE` | `/agents/schedules/{schedule_id}` | `{id, object:'agent.schedule.deleted', deleted:true}` |
| `POST` | `/agents/schedules/{schedule_id}/pause` | `AgentSchedule` (`status:'paused'`) |
| `POST` | `/agents/schedules/{schedule_id}/resume` | `AgentSchedule`; needs a future occurrence, else 400 `not_future` |
| `POST` | `/agents/schedules/{schedule_id}/run` | `AgentSchedule` after delivery; 409 `schedule_execution_pending` while a run is active; 404/409 for an archived or missing target |
| `GET` | `/agents/schedules/{schedule_id}/runs?limit=&before=` | `{object:'list', data:[AgentScheduleRun], has_more, next_before}` from `history()` |

Create body: `{title, prompt, timing, session_id?, agent_id?, agent?:{model, reasoning?, instructions?}, environment?}`; `agent`/`agent_id`/`environment` follow `CreateSessionParams` and are ignored when `session_id` is given.

`AgentSchedule`: `{id, object:'agent.schedule', title, prompt, timing, status:'active'|'paused'|'ended', next_run_at: string|null (ISO, null unless active), created_at, updated_at, revision, session_id, running: boolean, last_run: AgentScheduleRun|null, source: 'api'|'chat'}`. `source` is `chat` when the task's `involvedSessionIds[0]` differs from a session this API provisioned (metadata `source:'schedule'`); optional, may be dropped if it needs a lookup per row.

`AgentScheduleRun`: `{scheduled_at, delivered_at, message_id, session_id}`.

`timing` output form = input form (`{kind:'weekly', weekly:{time:'08:00:00.000', time_zone, weekdays:[1,2,3,4,5]}}`; `at` echoes the UTC instant; `after` echoes `after_seconds`; `cron`/`rrule` as given).

Validation and errors: DSH `ScheduleInputError.code` -> 400 with `error.code` = that code (`invalid_rule`, `invalid_time_zone`, `not_future`, `frequency_too_high`, `invalid_prompt`, ...); `schedule_not_found` -> 404; `schedule_conflict`, `schedule_execution_pending` -> 409; `RemoteError schedule/target-archived` -> 409 `schedule_target_archived`; missing service -> 501 `schedules_unavailable`. Body fields are checked for type first (`title` string 1-120, `prompt` non-empty string, `timing` object with a known `kind`).

Pagination: list in memory from `catalog()` (sorted by DSH `compareEntries`: active by next run, then paused/ended newest first), filter by owner and `status`, then slice by `after` id and `limit` (default 20, max 100).

## 5. Backend tasks

Conventions: TDD, `pnpm typecheck && pnpm test` (see `package.json`) per task; update `openapi/agentry.yaml` in the same commit as any route/wire change; changelog entry in the final task. Commit as the repo's configured user (no AI attribution, per AGENTS.md).

**B0 — Verify prerequisites (spike, no code kept).** Boot the `agentry` profile (`tests/loader-composition.spec.ts` pattern or `scripts/`), confirm `ctx.get('schedule')` resolves, `GET /agents/tools` lists `schedule_create/list/view/edit` for the default preset, and `sessionController` exists. Output: 3 lines in the PR description. If the default preset lacks `tool-schedule`, B6 also mounts it via the agent preset patch (stop and ask the controller).

**B1 — Store: owners of many sessions.** Files: `src/store/store.ts`, `src/store/postgres.ts`, `tests/support/memory-store.ts`, `tests/store.spec.ts`. Interface: `sessions.ownersOf(ids: readonly string[]): Promise<Map<string, OwnerId>>` (single `select id, owner_id from sessions where id = any($1)`; empty input returns an empty map without querying). Tests: returns only existing ids; empty list; works in both Memory and Postgres suites; `guardStore` wraps it (503 behavior test as for other methods).

**B2 — Extract session provisioning (refactor).** Files: `src/gateway.ts`, `tests/gateway.spec.ts`. Move lines 414-532 of `createSession` into `provisionSession(owner, body): Promise<{sessionId, projector, base, resolved}>` that throws `AgentsApiRequestError` (400) for the existing `badRequest` branches and rethrows `StoreUnavailableError`; `createSession` becomes request parsing + `provisionSession` + streaming/turn start. Public method `createIdleSession(owner, params)` for the schedule routes. Tests: existing `gateway*.spec.ts` unchanged and green; new: `createIdleSession` inserts an index row for the owner, starts no turn, rolls back on `agents.create` failure.

**B3 — Schedule routes.** Files: new `src/schedules.ts` (class `ScheduleApi`: `routes()`, handlers, `toWireSchedule(entry)`, `toWireTiming(record)`, `mapScheduleError(error)`, `ownerOf(entry, ownerMap)`), `src/gateway.ts` (spread `scheduleApi.routes()` before `/agents/:agent_id`; ctor gets `schedule: () => ScheduleService | undefined`), `src/index.ts` (add `'schedule'` handling via `ctx.get('schedule')` at request time, not in `inject`, so profiles without it still load), `src/types.ts` (`AgentSchedule`, `AgentScheduleRun`, `CreateScheduleParams`), `tests/schedules.spec.ts`, `tests/support/fake-schedule.ts` (in-memory `ScheduleService` fake with `catalog/view/create/edit/run/history` and recorded calls). Behavior as section 4. Tests (each a separate `it`): create provisions session and calls `create` with `{kind:'session', sessionId}` and `actorSessionId`; create with foreign `session_id` -> 404; invalid timing -> 400 with DSH code; failed create deletes the provisioned session; list excludes another owner's tasks and includes a chat-created task (target = owner's session, `involvedSessionIds` only); get/update/delete/pause/resume/run/runs of another owner's id -> 404 (and never call the service's mutating methods); `revision` mismatch -> 409; `schedule_execution_pending` -> 409; list pagination `limit/after/has_more`; `status` filter; timing round-trip for all 7 kinds (`toWireTiming` table test, include `time` normalized `HH:mm:ss.SSS`); service absent -> 501.

**B4 — Resolve agents through Agentry; clean up on delete.** Files: `src/gateway.ts` (public `agentFor(sessionId): Promise<Agent | undefined>`: `store.sessions.get(id,'any')`, `ensureLive(row)`, `handles.get(id)?.agent`), `src/index.ts` (`ctx.effect(() => ctx.on('schedule/resolve-agent', (sessionId, next) => gateway.agentFor(sessionId).then(a => a ?? next())))` — waterfall listener MUST call `next()` when it does not own the id), `deleteSession` (delete tasks whose `target.sessionId` is the session, via `catalog()`), `tests/schedule-resolve.spec.ts`. Tests: known id resumes a non-live session and returns its live agent, registered in `sessionRegistry`; unknown id calls `next()`; row without `body` surfaces the 409 `session_not_resumable` as a delivery failure (task stays stored, DSH reports it); concurrent resolves resume once (`resuming` map); deleting a session deletes its schedules and leaves others. **Opus** (concurrency with `resuming`, waterfall contract, teardown ordering).

**B5 — Show scheduled prompts in the chat history.** Files: `src/items.ts`, `src/types.ts` (`OAIMessageItem.source?: 'schedule'`, `schedule_id?: string`), `openapi/agentry.yaml` (`MessageItem`), `tests/items.spec.ts`, `tests/history/*`, `tests/openapi-contract.spec.ts`. `source.kind === 'schedule'` projects a user message item with text = the prompt extracted from the framing (`reminder_prompt_json:` line, or `reminders_json` joined; fall back to the full text when parsing fails) and `source:'schedule'`. Tests: single reminder, batch reminder, malformed framing falls back; `source.kind` of `schedule`-change notices (`[SCHEDULE CHANGE]`, same source kind, `index.ts:714`) must NOT become items — detect by the `[SCHEDULE REMINDER` prefix; live and replayed projections agree (existing replay-equality test pattern).

**B6 — Prompt guidance for chat-created tasks.** Files: `src/mount-instructions.ts` (or new `src/mount-schedule-guidance.ts`), `src/gateway.ts` `buildAgentSetup`, test beside `tests/mount-instructions.spec.ts`. Register a system-prompt section `agentry:schedule` (order just after `tool:schedule`; read `DSH:tool-schedule/src/index.ts` for its name/order) only when `schedule_create` is visible: "Always use target `this_session`. The user's time zone is the one stated in the conversation; ask if unknown." Tests: section present when the tool is mounted, absent otherwise, absent after `host_tools.deny: ['schedule_create']`.

**B7 — Contract and docs.** Files: `openapi/agentry.yaml` (9 operations, schemas `AgentSchedule`, `AgentScheduleRun`, `ScheduleTiming` (oneOf by `kind`), `CreateScheduleParams`, `ScheduleList`; reuse `Error*` responses, add 409/501), `docs/http-api.md` (section "Scheduled tasks": ownership rule, targets, time zone, error codes, one curl example), `docs/changes/2026-11-09-scheduled-tasks.md`, `docs/README.md` row, `CHANGELOG.md`, `AGENTS.md` Status line. Gate: `tests/openapi-drift.spec.ts` and `openapi-contract.spec.ts` pass with the new routes; add contract fixtures for create/list/runs responses.

**B8 — Live verification (manual, controller).** Against a running profile: create an `at` task 90 s out (REST), restart the server, confirm the run is delivered into the non-live session after restart (items show the scheduled prompt, assistant reply, status back to `idle`); create from a chat with `schedule_create`, confirm it lists under that owner and a second api-key owner does not see it; `run` now. Record results in the change note.

## 6. Frontend tasks

Conventions: astryx rules in `AGENTS.md` (templates first, no raw `<div>`, theme tokens, `astryx component <Name>` before using a component); all strings through the existing text patterns of the codebase; dated `CHANGELOG.md` bullet; `pnpm typecheck && pnpm test`; e2e mock API gets the new routes. Never put credentials in the browser (BFF only).

**F1 — Allow-list, types, client.** Files: `src/server/allowlist.ts` (add `'schedules'` to `RESERVED_AGENT_IDS`; new `SCHEDULE` segment kind; rules: `GET,POST ['agents','schedules']`; `GET,POST,DELETE [..., SCHEDULE]`; `POST [..., SCHEDULE,'pause'|'resume'|'run']`; `GET [..., SCHEDULE,'runs']`), `src/api/types.ts` (`AgentSchedule`, `AgentScheduleRun`, `ScheduleTiming`), `src/api/client.ts` (`listSchedules`, `getSchedule`, `createSchedule`, `updateSchedule`, `deleteSchedule`, `pauseSchedule`, `resumeSchedule`, `runSchedule`, `listScheduleRuns`). Tests: `tests/unit/allowlist.spec.ts` (each rule allowed; `/agents/schedules/..%2f` and `/agents/schedules/x/other` rejected; `GET /agents/schedules` no longer treated as an agent id), `tests/unit/api-client.spec.ts` (URL, method, body, CSRF header, error mapping for 400/404/409).

**F2 — Schedule helpers (pure).** Files: `src/schedule/describe.ts`, `src/schedule/form.ts`, `src/schedule/templates.ts`, tests `tests/unit/schedule-*.spec.ts`. `describeTiming(timing, locale): string` ("Weekdays at 8:00 AM", "Every Friday at 4:00 PM", "Daily at 9:00 AM", "Every hour", "Once on Nov 12, 2026 at 3:00 PM", cron/rrule -> "Custom schedule"); `formToTiming(form)` / `timingToForm(timing)` with frequencies Once, Hourly (`every` 3600), Daily, Weekdays (`weekly` 1-5), Weekly (`weekly` with chosen weekdays), Custom (`cron`); each round-trips; seconds/ms in `time` tolerated. Templates (section 3.3) each yield a valid form. Tests: table-driven for all frequencies, `Once` in the past is a form error, time zone defaulting.

**F3 — Sidebar entry and list page.** Files: `src/ui/shell/Sidebar.tsx` (`SideNavItem label="Scheduled" icon={ClockIcon} href="/scheduled" isSelected={pathname.startsWith('/scheduled')}` between New chat and chats), `app/(app)/scheduled/page.tsx` (server page, `requirePageSession`, `TopBar title="Scheduled"`), `src/ui/scheduled/ScheduledPage.tsx` (client). Layout from the `library` template frame: `TabList` with **Yours** and **Templates**. Yours: astryx `Table` (columns Name, Schedule (`describeTiming`), Next run (`Timestamp`), Status (`Switch` active/paused; ended = `StatusDot` + "Ended"), row `MoreMenu`: Run now, Edit, Delete (`AlertDialog`)); row click opens detail. `EmptyState` with "No scheduled tasks yet" and the New task menu. Templates tab: `ClickableCard` grid (title, description, schedule text). Header action **New task** = `DropdownMenu` with "Create with chat" and "Set up manually". Loading `Skeleton`, error `Banner` + retry, 401 -> login (same helper as `Sidebar`). Tests (`tests/component/scheduled.spec.tsx`, jsdom): empty state; rows render with schedule text; toggle calls pause then resume and reverts on failure; Run now shows a confirmation `Toast`; delete confirm calls DELETE; menu items navigate to `/?schedule=1` and `/scheduled/new`; template click navigates to `/scheduled/new?template=<id>`.

**F4 — Form page (create and edit).** Files: `app/(app)/scheduled/new/page.tsx`, `app/(app)/scheduled/[id]/edit/page.tsx`, `src/ui/scheduled/ScheduleForm.tsx`. Start from `astryx template contact-form`. Fields: Name (`TextInput`, max 120), Prompt (`TextArea`), Frequency (`SegmentedControl`/`Selector`: Once, Hourly, Daily, Weekdays, Weekly, Custom), Time (`TimeInput`, hidden for Hourly), Date (`DateInput`, Once only), Weekdays (`ToggleButtonGroup` Mon..Sun, Weekly only), Cron expression (`TextInput`, Custom only, helper text), Time zone (`Typeahead` over `Intl.supportedValuesOf('timeZone')`, default browser zone), Model (reuse the `NewChat` model picker; create only). Submit "Create task" / "Save changes"; inline field errors from API codes (`invalid_rule`, `invalid_time_zone`, `not_future`, `frequency_too_high`). Edit sends `revision`; a 409 shows a banner "This task changed elsewhere" with a reload action. Tests: field visibility per frequency; submit payload per frequency; template prefill; API error maps to field/banner; edit prefill from `timingToForm`.

**F5 — Detail page.** Files: `app/(app)/scheduled/[id]/page.tsx`, `src/ui/scheduled/ScheduleDetail.tsx`. `MetadataList` (schedule, next run, time zone, status, created), actions row (Pause/Resume, Run now, Edit, Delete), prompt block (`Markdown`/`Text`), **Runs** `Table` from `/runs` (delivered at, link to `/c/{session_id}`), "Load more" via `next_before`, "Open chat" link to the task's session. 404 -> `EmptyState` "Task not found". Tests: renders summary and runs; run now refreshes runs; pause/resume toggles; delete navigates back to the list.

**F6 — Create with chat.** Files: `src/ui/chat/NewChat.tsx` (read `?schedule=1`), `src/ui/chat/Composer.tsx` (new optional `initialValue` prop, applied once), `src/schedule/seed.ts` (`buildScheduleSeed(timeZone)`: "I want to set up a scheduled task. My time zone is {tz}. Ask me what it should do and when it should run, show me the plan, and once I confirm create it with the schedule tools, delivering to this chat."). The seed fills the composer; the user can edit and sends it (nothing is sent automatically). After the chat starts, the sidebar shows it normally; the task appears on `/scheduled` on next visit (refetch on mount and on `SESSIONS_CHANGED`). Tests: composer prefilled and focused; no auto-send; plain `/` unchanged.

**F7 — E2E.** Files: `tests/e2e/scheduled.spec.ts`, mock API routes in the existing mock server (`tests/e2e` support): empty list -> create manually (Weekdays 08:00) -> appears with "Weekdays at 8:00 AM" -> pause -> run now -> runs listed -> delete. Plus template flow prefill and the Create-with-chat composer seed. Record fixture shapes from the real backend after B8 into `tests/fixtures/live/` (existing convention).

## 7. Out of scope (phase 2)

- One new chat per run (claude.ai style). Needs adopting `new`/`new_once` sessions: in `schedule/resolve-agent`, for an unknown reserved id belonging to an Agentry-owned task, `ctx.agents.resume` the just-created DSH session with the creator's stored `SessionConfig` and insert the index row. Spike required (controller.create runs before the resolver).
- Notifications (email/push) on completion; run result status per run (receipts only confirm inbox delivery, `README.md` Summary: "A receipt is not model completion"); admin-editable templates; schedule filters by agent; per-owner schedule isolation for the model tools.

## 8. Model assignment (question 8)

- **Sonnet** (well-specified): B1, B3, B5, B6, B7, F1-F7, and B0/B8 execution notes. B3 is the largest but its tests are fully enumerated.
- **Opus**: B2 (refactor of the session-create path while keeping every existing gateway test green) and B4 (waterfall/resume concurrency and teardown). Opus also reviews the B3+B4 diff for owner-scoping holes (any mutating path reaching the service before the ownership check).
- Order: B0 -> B1 -> B2 -> B3 -> B4 -> B5 -> B6 -> B7 -> B8; frontend F1-F2 can start after B7's OpenAPI lands (generate types or hand-write `types.ts`); F3-F6 parallel, F7 last. One session per repository.

## 9. Resolved (2026-11-10)

1. v1 uses one chat per task; per-run chats come in phase 2.
2. The agent tools stay host-wide while there is one user per container; owner filtering goes in the backlog (AGENTS.md Backlog item 6).
3. There is no `agent_id` picker in v1: the form offers only a model choice and uses the default agent.
