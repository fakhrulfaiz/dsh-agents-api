# Durable subagents and subagent approvals (2026-11-26)

## Subagent history survives a restart

Before: subagent state lived only in `SessionRegistry` (`subagents` map). After a restart the `/subagents` routes were empty and subagent tool images were no longer served.

Now:

- `src/history/child-projector.ts` (`ChildProjector`, `foldChild`) projects a child's own events onto turns and items. The live registry keeps one per child (`SessionRegistry.applyChildEvent`), and `SessionHistory.subagents()` folds the child's Session log through a fresh one. Turn ids are `turn_<seq>`, item ids come from `itemsFromEvent`, and times come from the events, so both paths return the same objects. Turn statuses follow the parent projector (`aborted`, `interrupted`, `forked` end as `cancelled`; usage is kept).
- Children are found with `sessionQuery.traceSession(parent)`: direct descendants whose header says `origin: subagent` and `parentSession` is the session. A fork's inherited prefix (`inheritedEventCount`) is skipped, as the live hook never sees it.
- Rebuilt status: `active` while DSH holds the child live, else `closed` with `closed_at` = its last event's time (the live path now records the same value at dispose). `created_at` is the child header's `createdAt` on both paths.
- The gateway (`subagentsOf`) merges: a child the registry holds comes from memory (the cache), every other child is rebuilt. Owner scoping: every route checks the parent session's owner first, and a child is listed only under its own `parentSession`, so another session's child answers 404.
- The resource gains `model`: the model of the child's latest `request/header`, `null` before its first request.
- Tool images: the image source lists children from the registry and from the lineage trace, so subagent images are served after the child ends and after a restart.

## Replay stays live-only for subagent events

`agent.session.subagent.*` events are still ephemeral. They have no position in the parent's frame sequence (frame ids are positions in the parent's own log), and giving them one would mean merging separate logs by timestamp under a new id scheme that a saved `Last-Event-ID` cannot express. Clients re-read `/subagents` on open and on reconnect, which is now complete after a restart.

## Subagent approvals

`installApprovalBridge` takes `claims(agent) => { sessionId, subagentId? }`; `claimAgent()` claims a registered session, or a subagent (header `origin: subagent`) whose `parentSession` is registered. A subagent's request becomes an `approval` action on the parent with `subagent_id`, and the parent's `agent.session.input.approval_response` answers it. The `approval/asked` id is matched on the child's own log.

Lifetime: an entry remembers which session asked. A session's `turn/end` cancels only its own requests, so a child request survives the parent's turn end; the gateway re-shows pending requests after the parent's turn end, and the projector shows `requires_action` with no open turn while a child request is pending (clearing sends an ephemeral `agent.session.idle`). The child's turn end or dispose, `agent.session.input.cancel` on the parent, and deleting the parent cancel it.

Questions: `UserQuestionService.ask` (and `askTimed`) refuses any agent that is not a live root with `DELEGATED_CALLER` before the `user-questions/request` waterfall runs, so subagent questions can never reach the bridge. Timed questions of root sessions remain unclaimed (they need an `attachWait` client claim).
