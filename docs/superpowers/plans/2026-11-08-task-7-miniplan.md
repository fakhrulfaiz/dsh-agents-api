# Task 7 miniplan: request-reconstruction spike and admin API

Research only. No product code written. DSH paths are relative to `/home/mffaiz/code/dsh-pinned/packages` (abbreviated `P/`). Plan task: `2026-11-08-agentry-api-foundation.md` Task 7. Spec: section 6.

## 1. Spike verdict

**Feasible, by a documented composition of public APIs. No single `reconstructStepRequest` function exists in DSH.** The golden test (plan Step 1) is still the arbiter. Reconstruction target is the `GenerateOptions` the loop hands to `LlmRuntime.stream` (the pre-adapter request), not provider wire bytes.

### Evidence

| Claim | Evidence |
|---|---|
| DSH contract: every loop request is a pure function of the log | `docs/architecture.md:128` ("Model-visible means logged"); Agent Note `.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md` ("anyone holding the log ... reconstructs every loop request byte-for-byte") |
| The system prompt is logged per change as a surface node, not in the header | `docs/subsystems/session.md:185`; `core/session/src/types.ts` `'system/message'` doc; `core/agent-loop/README.md:156` ("Non-empty `system/message` nodes carry the prompt"). So `system` = first/latest effective system message in `deriveMessages()`; `GenerateOptions.system` stays undefined for loop requests (`llm/llm/src/types.ts:577-581`) |
| Exactly what the loop sends | `core/agent-loop/src/agent.ts:728-745`: `{ ...header.config, messages: session.deriveMessages(), toolHistory: session.toolHistory(), tools: header.tools, sessionId, signal }`, where `header` is the `request/header` snapshot just logged (`agent.ts:660-700`) |
| Header folds from the log | `foldRequestHeader(events, from?)` `core/session/src/request-header.ts:63`; `Session.requestHeader()` (`core/session/src/index.ts`, ~line 927 region) |
| Messages, including after compaction and plugin projections | `Session.deriveMessages()`; compaction is a logged surface replacement folded by `foldSurface` (`core/session/src/surface.ts:594`); plugin-owned projections (image offload) need explicit definitions for detached readers (`docs/subsystems/session.md:367`) |
| Detached readers have the projections | `currentSessionMessageProjections` exported from `@deepseek-ai/dsh-session-format-catalog/message-projections` (`session/session-format-catalog/package.json` exports; `src/message-projections.ts:7`). `session-query` itself uses it (`session-query/session-query/src/index.ts:7,191`) |
| Detached `Session` over an event prefix | `Session.create(id, seed?, header?, inheritedEventCount?, projections?)` `core/session/src/index.ts:~585-593` |
| Full events are reachable | `SessionQueryEngine.readSession(id) -> { session: SessionHeader, inheritedEventCount, events }` (`session-query/src/index.ts`, ~line 90 of class; types `types.ts:51-58`). `listEvents` returns metadata only, no bodies (`types.ts:61-72`), and `readSurface` returns only the final surface (`types.ts:39-48`), so neither alone gives step N. The plan's Step 2 wording ("from `listEvents`") must change to `readSession` |
| Route/model metadata | `request/context` event (`docs/subsystems/session.md:212`); `Session.requestContext()` gives provider, model. `header.config` already carries provider/model/temperature/maxTokens/stop/reasoningEffort (`GenerateOptions`, `llm/llm/src/types.ts:564-606`) |

### Composition: `reconstructStepRequest(sessionQuery, dshSessionId, stepId)`

`stepId` = `"<turn>.<step>"` (Agentry-defined; DSH has `step/start {turn, step}` events, `types.ts:305`).

1. `snap = await sessionQuery.readSession(id)`; throws `SESSION_QUERY_SESSION_NOT_FOUND` (map to `undefined`).
2. Locate `step/start` for (turn, step). Cut = seq of the first `assistant/attempt` or `assistant/message` event with the same (turn, step); if none (step failed before any model output), the matching `step/end` seq. Everything before the cut is committed before dispatch (`reconstructable-requests.md`: "The open step is the reconstruction boundary").
3. `prefix = snap.events.slice(0, cut)`;
   `s = Session.create(id, prefix, snap.session, snap.inheritedEventCount, currentSessionMessageProjections)`.
   Caveat: `Session.create` validates seeds, and a prefix ending mid-turn must still validate; the golden test covers it. If it throws on the open turn, append `interruptedTurnClosers(prefix)` (exported from `dsh-session`, `core/session/src/index.ts:32`) to a copy.
4. `header = s.requestHeader()`; `messages = s.deriveMessages()`; `th = s.toolHistory()` (optional, for completeness only).
5. Return `ModelRequest`:
   - `system`: text of the effective leading system message (`messages` entry with role `system`; empty string when none).
   - `messages`: `deriveMessages()` unchanged (keep the system message in `messages` too, since that is what the provider sees; document that `system` is a convenience copy).
   - `tools`: `header.tools ?? []`.
   - `model`: `header.config.model`. `parameters`: `header.config` minus `provider` and `model` (include `provider` in `parameters`; it selects the route).
6. Do NOT call `appendPluginRecord`/`append` on `s`. The session is throwaway.

### Known gaps (state in the docs change; none fails the spike)

- Provider-specific wire serialization (tool-history projection into `tools`/deferred declarations, image bytes resolved from `ctx.attachments`) is adapter-side and not reconstructed. `ModelRequest.tools` are the full active schemas, and image parts stay as attachment refs. Spec 6.2 field list matches this level.
- Code version drift: system prompt text is logged, but message projections and `deriveMessages` come from the pinned DSH build. Agentry pins DSH (`dsh.pin`), so a mismatch is only possible across upgrades; surface `dshVersion` in `/health/details`.
- `agent/request` waterfall may replace the call-config seed (`agent.ts:631`), but the result is what `request/header` logs, so no divergence.

## 2. Golden test design (plan Step 1)

- Recording provider: the lowest-cost option is an `llm/stream` waterfall listener (the hook, `llm/llm/src/index.ts:75`, dispatched at `:1180`) installed through the in-process host that records `options` and yields scripted chunks. `test-support/llm-replay` (`installLlmReplay`, `llm-replay/src/index.ts:1037`) is the existing catch-all `llm/stream` implementation for recorded fixtures, but it replays Session JSONL and is heavier than needed. `llm-mock-server` (`startMockLlmServer`, `llm-mock-server/src/index.ts:643`) is a Messages-protocol HTTP server for adapter fault tests; it sees wire JSON, not `GenerateOptions`, so it cannot be the golden oracle. **Use own listener** (about 25 lines in `tests/support`); no existing named fake records `GenerateOptions` for us.
- Loop requests arrive deep-frozen with the loop marker (`llm/llm/src/index.ts:70-74`); the recorder must `structuredClone` them (drop `signal`, `toolHistory`, `sessionId`) before comparison.
- Session: 3 turns, one tool call (use a registered test tool), one forced compaction between turns 2 and 3 (call the compaction service/plugin directly through the DSH host; if forcing is awkward, a low `contextWindow` model config triggers it). Assert for every recorded request: `reconstructStepRequest(...)` deep-equals the normalized recording, including the post-compaction step, and that the compaction step differs from the pre-compaction history.
- The comparison normalizes recorded `GenerateOptions` into `ModelRequest` through the same pure mapper used by production (`toModelRequest(options)`), so the test covers log -> state, not the mapper.
- Persisted path: run twice, once live-observed, once after restarting the host and reading cold from `$DSH_ROOT` (covers `readSession` cold reads and `interruptedTurnClosers`).

## 3. Fallback if the spike fails (needs user approval before any code)

- Hook: `llm/stream` waterfall (`llm/llm/src/index.ts:75`), filtered by the loop marker `markAgentLoopRequest` (`llm/llm/src/call-config.ts`, exported by `dsh-llm`) so compaction and title one-shots are excluded. `agent/request` (`agent.ts:631`) is unsuitable: it only sees the config seed.
- Payload: the frozen `GenerateOptions` (messages, tools, config, sessionId) plus the step id read from the last `step/start` of that session.
- Storage (spec 6.2): Postgres `model_requests(session_id, step_id, body jsonb, bytes int, created_at timestamptz)`, `admin.capture: { maxBytes, retentionDays }`, nightly retention delete; migration `0002-model-requests.sql`.
- Trade-offs: (+) exact bytes at the llm seam, independent of DSH projection drift; (-) contradicts AGENTS.md decision 7 ("never duplicate model requests into Postgres") and must amend it; each step repeats the full history, so storage grows O(steps x history) (needs `maxBytes` truncation, which makes captured requests lossy); stores prompts and tool outputs in a second place with its own retention and access-control burden; steps taken before enabling capture have no request (the log-derived path works retroactively); and the capture can drift from the log, defeating "log is the source of truth".

## 4. Admin routes (spec 6.1), with sources

Prefix `/admin/v1`; same `Route[]` plus `matchRoute` pattern as `src/gateway.ts:69,251` (`:id` params, `matchRoute` in `src/http.ts:110`). Every handler: `authenticate` -> `requireRole(result, 'agentry-admin')` (`src/auth/authenticator.ts:57`) -> `store.audit({ actor, action: "METHOD /pattern", target })` -> handle. Audit before the handler runs, with `target` = path params joined (session id, entry id, or `-`). A failed audit write (store down) returns 503 `store_unavailable` like the user gateway. Unauthenticated or non-admin calls write no audit row (no principal); say so in the README.

| Route | Source |
|---|---|
| `GET /sessions?owner&agent&status&from&to&q&cursor&limit` | Without `q`: `store.sessions.list({ owner: owner ?? 'any', agentId, status, from, to, cursor, limit })` (`store.ts:81,130`). With `q`: `sessionQuery.searchSessions({ query: q, limit })` yields DSH ids; join to index rows via a store lookup by `dshSessionId` and apply the other filters in memory (search returns DSH ids, the index has the owner). The `q` path pages by `SessionSearchCursor`, the other by the store cursor; document both cursors as opaque and mutually exclusive. If `store.sessions` has no by-DSH-id lookup, add `getByDshSessionId` to the Store in this task (Task 4 interface change, flag in handoff) |
| `GET /sessions/:id` | index row from the store plus `sessionQuery.traceSession(row.dshSessionId)`. Map: `{ ...row, trace: { complete, root?/unresolvedParentId?, ancestors: SessionRecord[], descendants: SessionLineageNode[] } }`. Project each `SessionRecord` to `{ id, parent, cwd, createdAt, live, persisted }` (do not leak `header` internals) |
| `GET /sessions/:id/messages` | `history.items()` from Task 5 if it already yields user/assistant items; otherwise `readSession` and keep `user/message` and `assistant/message` events (non-injected) |
| `GET /sessions/:id/steps` | `readSession` events folded: per (turn, step) `{ stepId, turn, model (request/context or header), usage (assistant/message.usage), startedAt (step/start.time), endedAt (step/end.time) }` |
| `GET /sessions/:id/steps/:stepId/request` | `reconstruct(...)`; `undefined` -> 404 |
| `GET /sessions/:id/log?cursor&limit` | `readSession(...).events` sliced by seq cursor (`cursor` = last seq seen); `nextCursor: null` at end. Whole-log read per page is acceptable now; note the cost |
| `GET /config` | `ctx.settings.describe({ redactSecrets: true })` (`settings/settings/src/index.ts:302`). Returns `SettingsDescriptor[]`: `{ ns (= entry id), schema (JSON), value, base, user, revision, applies: 'live', secrets }`, restricted to active, uniquely addressed, volatile fields. Redaction is mandatory because this is a remote surface |
| `PATCH /config/:entry_id` | see section 5 |
| `GET /health/details` | out of Task 7 scope in the plan's file list; stub reads (versions, DSH tag, Postgres ping) belong to Task 11 or health. Do not implement here unless the plan puts it in Task 7. The plan's Step 4 does not list it |

`from`/`to` parse as ISO-8601; invalid -> 400. Unknown query key -> ignore.

## 5. Config read/write

**Decision for the user**: the spec says "via `dsh-config-editor`", but `configEditor.edit()` takes a raw `Entry` and a `change(current, inherited)` function and writes the complete raw config. It does not know which fields are safe to change live. `dsh-settings` (`SettingsForms`, `static inject = ['configEditor','profileContext']`) is the schema-aware layer built on it. Recommendation: use `ctx.settings` (inject `'settings'`, which brings `configEditor`) for both read and write. Using raw `configEditor.edit` would let an admin rewrite any plugin field including secrets, with no schema listing. If the user wants the raw editor, add `'configEditor'` to `inject` as the plan says and build the schema list from `configEditor.configuration()` plus `entry.fiber.runtime.Config.toJSON()`; the plan's `inject` change then also requires a redaction pass we would write ourselves.

**PATCH body**: `{ patch: object, expectedRevision?: number }`. Call `ctx.settings.update(entryId, patch, expectedRevision)` (`settings/settings/src/index.ts:348`; `replace` and `mutate` exist for full-section or path edits; `update` merges).

**Error mapping** (all are plain `Error` except one; `edit()` throws `Error`s, `fiber.resolveConfig(next)` throws a schema validation error):

| Thrown | HTTP |
|---|---|
| `SettingsConflictError` (stale `expectedRevision`) | 409 `config_conflict` |
| `No configurable plugin entry "x"` / `... has no volatile fields` / `... is no longer configurable` (settings `write`, `settings/settings/src/index.ts:380-391`) | 404 `config_entry_not_found` |
| `Config field "a.b" is not volatile` | 400 `invalid_config` |
| Schema validation error from `fiber.resolveConfig` | 400 `invalid_config`, message passthrough |
| `Configuration for "x" is overridden by a home patch or command-line overlay` (`config-editor/src/index.ts`, end of `edit`) | 400 `config_overridden`; this is the "higher-layer overrides" case: the active profile patch is the only write target, and a higher layer (home patch, `--patch` overlay) would mask it, so the write is refused with the file unchanged |
| `Configuration entry is no longer available` / `... changed during reload` / `... plugin is no longer active` | 409 `config_entry_changed` |
| Anything else | rethrow -> 500 |

Matching is by error class and message prefix; there is no typed code on these errors, so wrap in `mapConfigError(error)` with one table and test each row with a fake `settings`. Since a rejected write "leaves the profile patch unchanged" (config-editor README: validates the complete candidate before touching disk), the 400 test asserts the fake `edit` was not called after validation failure, and one end-to-end test asserts the patch file bytes are unchanged on the overlay-conflict path.

Audit `target` for PATCH = `entryId`; do not log the patch body (may carry secrets).

## 6. Search backend availability

`@deepseek-ai/dsh-session-query-sqlite` is mounted in base with `path: ':memory:'`, `openAt: never` (`bundle/base/cordis.patch.yml:157-161`; web-app restates it, `bundle/web-app/cordis.patch.yml:27`). With `never`, `searchSessions` rejects with `SESSION_QUERY_SEARCH_DISABLED` (README line 67); exact reads, filters, traces still work. Enabling: in the deployment profile `cordis.patch.yml` (`deploy/profile/`, spec 7.1), override the row:

```yaml
- id: session-query-sqlite
  config:
    openAt: first-search   # or startup
    path: /data/dsh/session-search.sqlite   # durable derived index; single process owner
```

`first-search` defers the `node:sqlite` import and its experimental warning. Task 7 must add this row to `deploy/profile/cordis.patch.yml` (or defer to the Task that creates that file and record it in the handoff) and must handle `q` when search is disabled: catch `SessionQueryError` with code `SESSION_QUERY_SEARCH_DISABLED` -> 501 `search_disabled`. Test: `q with search disabled returns 501`. The sqlite index is derived and disposable: DSH may reset it; do not back it up.

Also: `src/index.ts` `inject` today is `['webServer','sessions','agents','agentDefaultModel','tools']`; add `'sessionQuery'` and `'settings'` (or `'configEditor'` if the user chooses the raw editor). The plan says only `'configEditor'`; `sessionQuery` is missing from the plan's inject change and must be added.

## 7. Files

- Create `src/admin/request-reconstruction.ts` (`reconstructStepRequest`, `toModelRequest`, step cut helper), `src/admin/admin-gateway.ts` (routes, `mapConfigError`, audit wrapper), `src/admin/steps.ts` (pure folds for steps and messages, so they are unit-testable without a host) if `admin-gateway.ts` would exceed ~300 lines.
- Modify `src/index.ts` (register `/admin/v1`; extend `inject`), `README.md` route table, `docs/changes/2026-11-08-admin-api.md`, CHANGELOG, `deploy/profile/cordis.patch.yml` (search row).
- No new dependency for `Session.create`: add `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-session-format-catalog` as peer plus dev deps, resolved through the pin (check `dsh:link` and `src/dsh-paths` for how existing deps are linked, `tests/dsh-paths.spec.ts`).

## 8. Test list

`tests/admin-request.spec.ts` (needs a booted DSH host from `$DSH_ROOT`; self-skip like existing host tests if unavailable):
- `rebuilt request equals provider request` (every step, live host)
- `rebuilt request equals provider request after restart` (cold read)
- `step after compaction omits replaced history`
- `unknown step id returns undefined`; `unknown session returns undefined`
- `reconstruction does not append to the session` (event count unchanged, live session)
- `failed step with no assistant event still reconstructs`

`tests/admin-gateway.spec.ts` (fake `sessionQuery`, fake `settings`, memory store from `tests/support/memory-store.ts`):
- `missing token gets 401` and `non-admin gets 403` (table over every route)
- `lists sessions across owners`; filters `owner`, `status`, `from`/`to`; `invalid from returns 400`; `q uses searchSessions and joins index rows`; `q with search disabled returns 501`; `bad cursor returns 400` (`InvalidCursorError`)
- `session detail includes trace tree` (complete and unresolved-parent traces); `unknown session returns 404`
- `messages` returns user and assistant only; `steps` includes usage, model, times; `steps/:id/request` returns `ModelRequest`; `log paginates` (cursor round trip, last page `nextCursor: null`)
- `config GET redacts secrets` (asserts no plaintext secret in body)
- `config PATCH validates`: invalid value -> 400, `settings.update` rejects, nothing written; valid value -> `update` called once with `(entryId, patch, expectedRevision)`; one test per row of the error table in section 5
- `every admin call writes one audit row` (actor, `METHOD /pattern`, target); `rejected requests write no audit row`; `audit failure returns 503`; `audit target for PATCH excludes body`
- `unknown admin route returns 404`

Commands: `pnpm vitest run tests/admin-request.spec.ts tests/admin-gateway.spec.ts`, then `pnpm test`.

## 9. Open questions for the user

1. Config layer: use `ctx.settings` (volatile fields only, schema-aware, redacted, revisioned; recommended) or the raw `ctx.configEditor.edit` the spec names? The first changes spec 6.1 wording ("from `dsh-config-editor`") to "through `dsh-settings`".
2. `GET /health/details` is in spec 6.1 but not in plan Task 7: which task owns it?
3. Search needs the `deploy/profile` override (section 6); confirm Task 7 should add it.
4. Store needs a by-`dshSessionId` lookup for `q`; OK to extend the Task 4 `Store` interface?
