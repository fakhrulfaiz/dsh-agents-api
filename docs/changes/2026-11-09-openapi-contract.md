# OpenAPI contract

`openapi/agentry.yaml` is the contract the frontend generates its TypeScript types from.

## Contents

- OpenAPI 3.1; paths carry the default `/v1` prefix, plus `GET /health`.
- `components.schemas` mirror `src/types.ts` for agents, sessions, turns, items, required actions (including `approval`), input events, and output events (`SessionEvent`). List responses use the cursor page (`object`, `data`, `first_id`, `last_id`, `has_more`).
- Errors share `ErrorResponse`; responses document 400, 401, 403, 404, 409, 500, and 503 with their `error.code` values.
- Security scheme `bearerAuth`: Keycloak access token, `agk_...` API key, or the development key. `OpenAI-Beta: agents=v1` is a documented header parameter.
- `GET /agents/sessions/{session_id}/events?stream=true` is `text/event-stream`: the `event:` name equals the payload `type`; `id:` is the deterministic position in the session's event sequence; ephemeral frames have no `id:`; `Last-Event-ID` resumes.

## Keeping it in sync

- `AgentsGateway.routeTable()` returns the registered method and pattern pairs. The drift test converts `:name` and `*name` to `{name}` and compares the sets, including `GET /health`.
- The contract test sends requests to a gateway over fake backends, validates request and response bodies and streamed frames against the spec with `ajv`, and checks hand-written fixtures for every required-action and input-event variant.
- Admin: add `AdminGateway.routeTable()` to `routeSets()` in `tests/openapi-drift.spec.ts` (prefix `/admin/v1`) when the admin API lands; the drift test currently asserts there are no `/admin` paths.

## Limits

- The binary downloads (`environments/.../files/{path}`, `sessions/.../artifacts/{path}`) are `application/octet-stream`.
- Resource schemas allow extra properties, so additive fields do not fail the contract tests.
