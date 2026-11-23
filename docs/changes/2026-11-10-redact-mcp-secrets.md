# Redact MCP secrets in responses (2026-11-10)

## Problem

A session created with an inline agent whose `tools` held a wire MCP tool echoed the transport secrets back: `headers` values for `http` transports and `env` values for `stdio` transports appeared in `POST /v1/agents/sessions`, `GET /v1/agents/sessions/{id}`, and `GET /v1/agents/sessions`. Saved agents (`/v1/agents`, `/v1/agents/{id}`) did the same.

## Behavior

- Every response and SSE event shows MCP `headers` and `env` values as `***`. Header and variable names, `server_url`, `command`, and `args` are unchanged.
- Storage is unchanged: `agents.body` and `sessions.body` keep the real values because mounting and restart recovery (`resumeSession`) read them from the stored configuration.
- Redaction is output-only, pure, idempotent, and returns copies; the stored configuration object is never mutated.
- `POST /v1/agents/{id}` with `tools` containing a `***` header or env value answers 400 `bad_request`. A client that read a masked agent must omit `tools` (keeps the stored ones) or send real values. `POST /v1/agents/sessions/{id}` cannot change tools, so it needs no check.

## Where it is applied

`src/redact.ts` exports `redactAgentSecrets`, `redactSessionSecrets`, and `findMaskedSecret`.

- `WireProjector.snapshot()` (`src/history/projector.ts`) masks the agent. Every `session` object in create, get, `agent.session.*` events, replay, and `SessionRegistry.getOAISession` / `applyConfig` comes from it.
- `sessionFromRow()` (`src/session-resource.ts`) masks the agent of sessions not live in this process (list, get, update after a restart).
- Saved-agent routes in `src/gateway.ts` (create, list, get, update) mask the stored record before `json()`.

The projection base (`ProjectionBase.agent`) keeps real values; it feeds only `mountMcpTools` through the stored config.

## Tests

`tests/redact.spec.ts` (helper), `tests/gateway.spec.ts` (create, get, list, update, SSE, saved agents, masked update refused, mount still receives real values), `tests/gateway-history.spec.ts` (cold read, resume, and replay after restart).

## Limits

- A real secret equal to the literal `***` cannot be set through `POST /v1/agents/{id}`.
- Secrets already returned before this change may exist in client logs; rotate them.
- The harness process must be restarted to pick up the change.
