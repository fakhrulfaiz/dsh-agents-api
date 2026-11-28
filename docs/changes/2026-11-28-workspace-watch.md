# Workspace artifact watch (2026-11-28)

## Intent

The web preview panel should reflect file changes while an agent turn is running. Polling on idle is not enough for long-running turns.

## Behavior

`GET /v1/agents/sessions/{session_id}/artifacts/watch` is an owner-scoped SSE stream:

- `event: changed` `data: {"paths":["src/a.ts"]}` - workspace-relative paths, deduplicated, debounced 500 ms.
- `event: reset` `data: {}` - too many paths in one window (>200); client reloads the full listing.
- `event: closed` `data: {}` - source ended (for example the sandbox stopped).
- `: ping` every 15 s.

Sandbox sessions watch through envd `filesystem.watchDir` (recursive). Local sessions watch through Node `fs.watch` recursive. One upstream watch is shared per session; it stops 30 s after the last subscriber. At most 8 watched sessions per owner; the 9th is rejected with 429 `too_many_watches`.

Reconnects start a fresh watch; the route does not use `Last-Event-ID`.
