# History from the Session log, restart recovery, SSE replay

## What changed

Items, turns, and the SSE event stream were kept in memory and lost on restart. They are now derived from the DSH Session log, which stays the source of truth for history (AGENTS.md decision 7). Nothing from a conversation is copied into Postgres.

- `WireProjector` (`src/history/projector.ts`) folds Session events into wire events, items, turns, status, usage, and `required_actions`. The live path applies each `session/event` to the session's projector; replay folds `sessionQuery.readSession(id).events` through a fresh one. Both number frames the same way: `id` is the 1-based position in the folded sequence, `agent.session.created` is frame 1, turn ids are `turn_<seq of turn/start>`, event ids are `evt_<session>_<id>`, and timestamps come from event times.
- `SessionHistory` (`src/history/session-history.ts`) serves `GET .../items`, `.../turns`, `.../turns/{id}`, and replay from that fold. Turns are listed in log order, not by second-resolution timestamps. Every request reads and folds the whole log; there is no cache (see Limits).
- `recoverSessions` (`src/recovery.ts`) runs after the store opens. Each `in_progress` or `requires_action` row is resumed through `ctx.agents.resume` (the gateway folds the log into a projector first, then resumes, so live ids continue the folded sequence) or marked `interrupted` with `last_error`. A row without stored setup is interrupted with `session predates stored configuration`. If the agent factory or session persistence is not available when the store opens (`recoveryUnavailable`), recovery is skipped with one warning and rows stay untouched; those sessions resume lazily on first POST. Recovery never fails the API.
- A POST to a session that is not live resumes it first. Rows without stored setup answer 409 `session_not_resumable`; a failed resume answers 500 `session_resume_failed`.
- Status is written to `sessions.status` by `AgentsGateway.recordStatus` where the projector produces the matching wire event, one ordered chain per session; failures are logged. `listResumable` therefore reflects live sessions.

## Schema

`0002-session-config.sql` adds `sessions.body jsonb not null default '{}'`: `{ agent, environment, metadata, vault_ids }` as resolved at create time and updated by `POST /agents/sessions/{id}`. It holds no conversation content and no model requests. Rows from before the migration read back as `body: null`.

## Wire behavior

See [HTTP API](../http-api.md#event-ids-and-replay). Ephemeral events (connect-time status snapshot, the idle event of a no-input streamed create, dispatch `error`) have no `id:` and are not replayed. An open turn at a crash becomes `cancelled` with `error.code: "interrupted"`. `agent.session.turn.cancelled` is emitted when the Host ends the turn.

## Other fixes folded in

- `GET /agents/sessions` maps index rows only, so `data`, `first_id`, `last_id`, and `has_more` agree.
- `workspaces` is required by `AgentsGateway` (`GatewayOptions.workspacesRoot`); artifact reads use the live workspace or the Session header `cwd`, and answer 404 when neither is known.
- `POST /agents/sessions/{id}` answers 404 when the row vanished between read and write.
- `PendingFunctionCalls` only parks and resolves calls. `required_actions` and the `requires_action` status derive from the logged `tool/call` and `tool/result`.

## Limits

- Replayed `session` snapshots inside events show the current configuration; configuration is not in the log.
- Subagent turns and items are still memory-only and lost on restart.
- Each history read is O(log size). A long-session benchmark and a bounded cache are follow-ups.
- `recoveryUnavailable` reads the `factory` field of `ctx.agents` because DSH has no public accessor; revisit if DSH adds one.
