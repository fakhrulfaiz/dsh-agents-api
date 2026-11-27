# 2026-11-26: the full item log on the session stream

Backlog item (agentry-web `AGENTS.md` item 6, first bullet): the SSE stream carried assistant messages only, so the web app polled `/items` and `/subagents` during a turn and stripped a reasoning prefix from message text.

## What changed

- **Item frames.** `GET /v1/agents/sessions/{id}/events` now carries every saved item: user messages, reasoning, tool calls (`agent.session.turn.item.added`, they wait for an output) and tool outputs (`agent.session.turn.item.done`). The assistant message keeps its existing frames (`item.added`, text deltas, `output_text.done`, `item.done`); its reasoning item comes just before it. Frames carry a copy of the item, so later timing updates never change a frame already sent. Live frames and a replay fold are identical (`src/history/projector.ts`, `#itemFrames`).
- **Ids.** Decision: keep the original frames' ids `1..n` and number item frames after the frame before them, `<n>.<sub>` (`12.1`, `12.2`). Existing ids did not move, so `Last-Event-ID` values saved by clients before this change still resume at the same place, and payload `event_id`s are `evt_<session>_<n>.<sub>` for item frames. Clients compare ids as (`n`, `sub`) pairs (`parseFrameId`, `compareFramePositions`). The alternative, renumbering every frame, would have been simpler but would have shifted ids that clients already hold.
- **Attachments.** A user message item streamed live or replayed names its attachments by file id, as `GET .../items` does (`streamedEvent` in `src/gateway.ts`); frames are written through one promise chain so order is kept while the ids are looked up.
- **Reasoning out of message text.** DSH saves an assistant message's content with `{type: 'reasoning', text}` blocks in front of the text; `textFromContent` (`src/input.ts`) joined them in, which is where the reasoning prefix the web app stripped came from. It now skips reasoning blocks, so the message text (stream, `/items`, everything) is the answer only. The reasoning stays available as its own `reasoning` item.
- **Subagent events.** New ephemeral events on the parent stream: `agent.session.subagent.created`, `.updated` (child turn opened or ended, carries `turn`), `.closed`, `.item.added` and `.item.done` (child items, each with `subagent_id`). Decision: live only, no id, never replayed. Child state lives in memory (`SessionRegistry`) and is not in the parent's log, so a replay could not reproduce it; clients re-read `/subagents` on open and on reconnect. Distinct `subagent.*` types keep child items out of the parent chat in clients that do not know them.

## Not changed

- No reasoning deltas: DSH commits a step at once, so a reasoning item arrives as one `item.done`.
- Per-item timestamps and per-step token usage (the other bullets of the web backlog item) are separate work.
