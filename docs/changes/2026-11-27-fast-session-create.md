# Fast session create (2026-11-27)

## Problem

`POST /v1/agents/sessions` took about 1.8 to 2 s when the agent carried an MCP tool (for example the owner's Composio connector that the web BFF adds), against 0.1 s without one. The create awaited `ctx.agents.create`, whose setup mounts the MCP tools, and DSH's `mcp-client` blocks activation on the first connection and tool discovery on purpose, so the tools exist before the agent's first step.

## Decision

The create answers once the session is validated, its projector registered and its index row stored; the agent is built in the background. DSH's guarantee is kept: no turn runs before setup is done.

- **Status while setting up.** A create with input answers `in_progress` (the row and the projection say so) and the message waits; without input it answers `idle`. No new status value: `in_progress` already means "the session is working on input", which a client shows as busy.
- **Queued first message.** When setup ends the first message starts the turn. A cancel or a session delete sent during setup drops it (its staged files are released) and the session goes `idle`.
- **Requests that need the agent wait** for setup: follow-up messages, cancel, approvals, tool results, settings changes that reach the live agent, commands, the skill and command catalogs of the session, schedule deliveries (`agentFor`), and delete. They all go through `ensureLive` or `stopLiveAgent`, which wait on the setup job first.
- **Setup failure.** The session becomes `failed` with `error` / `last_error` "The session could not be set up" (the reason for an invalid MCP config or a sandbox that cannot start; `AGENTRY_DEBUG_ERRORS=1` appends the cause), the stream gets an ephemeral `error` and `agent.session.failed`, and the handle, pending calls and projector are removed. Later input events answer 409 `session_setup_failed`. This replaces the synchronous 500 `agent_create_failed` for failures during agent setup.
- **Still synchronous.** Validation (400/404), environment and file provisioning, a Sandbox environment whose preset cannot start (503 `sandbox_unavailable`: its preset lease is taken before the row is written and held for the setup) and a failed index write (500 `agent_create_failed`, 503 store).
- **Streaming create.** `agent.session.created` is written first, then either the turn's events, or `agent.session.idle` once ready (no input), or `error` and `agent.session.failed`.
- **Unchanged.** `createIdleSession` (scheduled tasks) still waits for the agent. Resume and startup recovery do not use the background path.

## Limits

A process that stops during the setup window leaves a row without a Session log: an `in_progress` row is marked `interrupted` by recovery (its queued message is lost); an `idle` row answers 500 `session_resume_failed` on its next input. The `session_setup_failed` answer lives in memory, so after a restart a failed session answers the resume error instead.
