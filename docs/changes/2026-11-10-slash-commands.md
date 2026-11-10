# Slash commands over the API

## What changed

The frontend's `/` menu needs the Host's slash commands (`/compact`, `/goal`, `/feedback`, ...). They run on the backend, outside a turn, never reach the model, and log `command/run` and `command/done` as log-only session events. Three additions expose them. Design and rationale: `docs/superpowers/specs/2026-11-10-slash-commands-design.md`.

- **Catalog.** `GET /agents/commands?session_id=` (`src/commands.ts`, `CommandsApi`) lists `CommandRuntime.list(agent)` as `{ name, description, input_hint?, accepts_attachments }`. A live session uses its agent as scope key; a session that is not live uses the default preset scope from `agentPresets.acquireScope()` and is not resumed. No `session_id` answers an empty list. The cache is keyed by scope object, bounded by `commands.cacheTtlSeconds`, and dropped by a generation counter on `commands/change` and on a logged `agent-preset/selected`.
- **Run.** `POST /agents/sessions/{id}/commands/{name}` (`AgentsGateway.runCommand`) checks the owner, resumes the session (`ensureLive`), refuses with 409 `session_busy` while the projector status is `in_progress` or `requires_action` or another command runs in that session, then calls `CommandRuntime.execute(agent, line, [], signal)`. `undefined` is 404 `command_not_found`; an error result is 200 with `status: "error"`; a thrown handler is 500 `command_failed` with a generic message. The request's `close` aborts the signal.
- **Item.** `WireProjector` keeps `command/run` records by `commandId` and emits one `slash_command` item and one `agent.session.item.done` frame on `command/done`. `turn_id` is the open turn or `null`. A run without a done, or a done without a run, shows nothing.

## Decisions

- Commands are blocked during a running turn (409). Safe in-turn commands (for example `/goal pause`) need a per-command allow list because descriptors carry no such flag; that comes later.
- A result produced between turns is its own item with `turn_id: null`, not attached to a turn. `turn_id` is therefore nullable on this item type only.
- Attachments are not forwarded (`[]`); a command that accepts them still works text-only.
- `/rename` is frontend-only (sessions already have `metadata.title`); there is no backend work.

## Compatibility

Sessions whose Session log already holds `command/run` and `command/done` pairs now project one extra frame per pair, so frame ids after the first command shift for those sessions. A client reconnecting with an old `Last-Event-ID` across the upgrade can miss or repeat frames; reloading the items list heals it.

## Tests

`tests/commands.spec.ts` (catalog, run, busy, abort, config), `tests/history/projector.spec.ts` (pairing and fold equality), `tests/gateway-history.spec.ts` (replay after restart), `tests/items.spec.ts`, plus the OpenAPI drift and contract specs.
