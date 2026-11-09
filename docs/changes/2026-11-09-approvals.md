# Approvals over the API, live model and effort

## What changed

Sandbox escalations, tool approvals, and user questions had no channel over the API: the Host's answerer chain ended in `unavailable`, and the wire client could not answer. Model and effort updates were stored but never reached the running agent.

- `installApprovalBridge` (`src/approvals/approval-bridge.ts`) registers `approval/request` and `user-questions/request` listeners through `ctx.effect`. A listener claims a request only when `agent.session.id` is a registered Agents API session; otherwise it calls `next()`, so the DSH web UI keeps answering its own sessions. A subagent's session id is never registered, so its approvals fall through and fail closed. Requests with an already aborted signal and timed questions (`wait.timed`) also fall through.
- A claimed request is parked and listed as an `approval` action. `onChange` reaches `AgentsGateway.setInteractionActions`, which calls `SessionRegistry.setInteractionActions`: the projector merges the actions into `required_actions`, recomputes the status, and the registry fans an ephemeral `agent.session.requires_action` / `agent.session.in_progress` frame out. The status is written to the index with `recordStatus`. Replay never holds approvals: they are not in the Session log.
- Approval ids are the ids DSH logs in `approval/asked`, paired by tool name and call id from the synchronous `session/event` stream; a request with no logged ask gets a minted `appr_` id. Question ids are the wait call id or a minted `appr_` id.
- `agent.session.input.approval_response` is parsed by `parseApprovalResponse` and answered through `ApprovalBridge.answer`. `approve` maps to `allowed-once`, `deny` to `rejected` (a skipped batch for a question), `answer` to the answer batch.
- Cancel, session delete, the logged `turn/end`, and `session/disposed` settle pending requests as cancelled and clear the actions, so a later answer is 404 `approval_not_found`. Pending state is memory only: after a restart DSH repair closes the turn and old ids are unknown.
- `AgentsGateway.changeSettings` runs for `POST /agents/sessions/{id}` and for `agent.session.input.message` carrying `model` / `reasoning.effort`. It validates with `ctx.llm.resolveCallConfig`, calls `agent.model.select` with a complete selection (provider from the model catalog, falling back to the live selection's provider), then writes the index and the live projection. Failures answer 409 `session_setting_not_live` before anything is stored.
- Session create passes `reasoning.effort` to `ctx.agents.create` (previously only the profile default effort was used) and rejects an unsupported effort with 400.

## Decisions

- Subagent approvals fail closed in v1. Supporting them needs a mapping from child session ids to the parent.
- Timed questions are unsupported: they need a client claim over the Host RPC; the Host continues the turn without an answer.
- `sandbox_escalation` is detected from the reason prefix `escalate sandbox to ` that `approveEscalation` writes (`dsh-sandbox`). A test feeds the bridge the reason produced by the real function.
- A message-carried model change is applied before the message is queued and is not rolled back if the message fails to queue; the stored setting matches the live agent either way.
- The index write follows `select`. If the index write fails (503), the live agent already runs the new selection while the stored value is the old one; the next successful update or resume reconciles it.

## Wire fields that change model or effort live

- `POST /agents/sessions/{id}`: `agent.model`, `agent.reasoning.effort`.
- `agent.session.input.message`: `model`, `reasoning.effort`.

## Profile requirements

`tool-ask-user` (legacy mode) must be mounted for questions; the approval policy must stay `ask`. The `agentry` profile (deployment task) must set both; see the README.
