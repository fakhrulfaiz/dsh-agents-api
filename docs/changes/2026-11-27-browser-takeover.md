# Browser take-over (2026-11-27)

The user can take control of a sandbox chat's browser from the live view (like OpenAI Operator), use it with mouse and keyboard, and hand it back to the agent. Builds on `2026-11-27-browser-live.md`.

## Routes (owner-scoped; see `openapi/agentry.yaml`)

- `POST /v1/agents/sessions/{id}/browser/control` `{ action: "take", force? }` answers `{ controlled: true, control_id, since, idle_timeout_seconds: 300 }`; `{ action: "release", control_id? }` hands it back. Taking needs an open live view of a sandbox chat whose agent has the browser (`409 browser_unavailable`, `409 browser_not_live`); a second `take` answers `409 browser_control_held` unless `force` (the web app's "Take control here").
- `POST /v1/agents/sessions/{id}/browser/input` `{ control_id, events }`: at most 50 events a request and 120 a second per session (`429 input_rate_limited`); a stale or missing grant answers `409 not_in_control`. Events (coordinates in the page's CSS pixels, the frame's `width`/`height`): `mouse` (move/down/up), `wheel`, `key` (down/up, `text` for a key that types, `"\r"` for Enter), `text` (inserted text, IME and paste), `resize` (320-1920 by 240-1440).
- The live stream gains `control` events: `{ controlled: true, since }`, `{ controlled: false, reason }` with `released`, `idle`, `left`, `taken` or `closed`.
- Read-only stays the default: nothing changes until a `take`.

## How it works

- `src/sandbox/browser-input.ts` checks the events (clamped numbers, bounded strings) and maps each to one CDP command: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`, `Emulation.setDeviceMetricsOverride`.
- The hub (`src/sandbox/browser-live.ts`) holds one grant per view and writes `{"type":"input","commands":[...]}` lines to the relay's stdin. The relay (`RELAY_COMMAND_SOURCE` in `browser-live-relay.ts`) runs only those four methods on the page it shows, at most 100 a line; any other line or method is ignored, so stdin is never a general DevTools channel and the DevTools port stays on the sandbox's loopback.
- Control ends after 5 minutes without input, 3 s after the last live-view reader leaves (a reconnect keeps it; the web app closes the stream when the tab is hidden or the chat is left), or when the view ends (environment stopped, reset or deleted).
- Page size: the first `resize` remembers the frame's size; on hand-back the relay sets it back. Clearing the override instead dropped Playwright's own 1280x720 viewport too (seen live: the page fell back to 1280x633).
- Smoother view: the default cap is now 10 fps (`browser.liveFps`, max 15), and a frame byte-identical to the last one is dropped in the relay and again in the hub.

## The agent's side (`src/sandbox/browser-control.ts`, hooks in `src/index.ts`)

A global `tools/pre-execute` hook gates `mcp__browser__*` calls; a `tools/post-execute` hook adds the note.

- While the user has control, a browser call **waits** until the hand-back, the idle timeout, or the turn is stopped (the call is then cancelled). Waiting keeps the turn parked; answering "the user has control" at once made the agent retry or give up.
- The waiting call **does not run** after a hand-back with input: it was planned on a page the user has since changed. It answers "The user used the browser and handed it back; look at the page again before continuing." If the user only watched (no input), it runs as usual.
- Until the agent looks again (`browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`), other browser calls answer the same note; the first look runs and gets the note in front of its result.
- Why the API and not the bridge: every browser call of the session passes this hook whatever the transport, the decision is made before anything reaches the sandbox, and the note reaches the model as the tool's own answer. The bridge only relays MCP bytes and cannot tell a call's purpose without parsing JSON-RPC.

## Verified (2026-11-27, dev Agentry Sandbox, throwaway sandbox from `ghcr.io/fakhrulfaiz/agentry-sandbox-browser:1`, deleted)

Playwright MCP started as mounted, `browser_navigate` to the Wikipedia main page, then the hub and the real relay: take control; a click on the search box, typing "Octopus" as key events and Enter moved the page to `/wiki/Octopus` (frames followed); a wheel event scrolled it (`scrollY` 300); a click on an article link opened `/wiki/Siphon_(mollusc)`; a resize to 900x600 changed the frames and `innerWidth`/`innerHeight`, and the hand-back restored 1280x720. A `browser_click` gate call made during control stayed waiting, then answered the hand-back note; the agent's `browser_snapshot` afterwards showed the user's page. The HTTP routes were covered by `tests/gateway-browser-live.spec.ts` with a fake relay, not through a running API.
