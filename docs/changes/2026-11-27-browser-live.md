# Live browser view (2026-11-27)

A read-only, live view of a sandbox chat's browser, for the web app's Browser tab.

## Route

`GET /v1/agents/sessions/{id}/browser/live` (owner-scoped, SSE; see `openapi/agentry.yaml`):

- `frame`: `{ data, url, title, width, height, timestamp }`, `data` a base64 JPEG (quality 60, at most 1280x960). A new reader first gets the last frame.
- `idle`: `{ reason }` while there is nothing to show:
  - `not_started`: no browser open yet (Playwright MCP starts Chromium on the first browser tool call), or the sandbox is not running;
  - `no_browser`: the sandbox has no `playwright-mcp` (standard image; use the built-in **Web and browser** template);
  - `browser_off`: the session agent's `browser` is off (no relay is started);
  - `not_sandbox`: the chat runs on the server (no relay is started).
- `error`: `{ code: "too_many_live_views" }` when the owner already has 4 live views; the stream ends.

The stream ends when the environment is stopped, reset or deleted; a client reconnects.

## How it works (`src/sandbox/browser-live*.ts`)

- Chromium listens for DevTools on the sandbox's loopback. `browserMcpTool` now starts `playwright-mcp --config <file>` through `/bin/sh -c`, writing a config file (`/tmp/agentry-browser-<port>.json`) whose `browser.launchOptions.args` adds `--remote-debugging-port=<port>`; the port (20000-39999) is derived from the session id (`browserCdpPort`), so two chats on one sandbox do not collide and the route knows the port. Playwright allows a user `--remote-debugging-port` next to its own pipe. Chats created before this change have no port and show `not_started` until a new chat.
- The relay (`BROWSER_LIVE_RELAY_SCRIPT`) is a dependency-free Node program run as `agent` with `node -e` over an envd process stream (the same way as the stdio bridge and terminals). It polls `http://127.0.0.1:<port>/json/version`, connects to the browser's DevTools WebSocket, discovers page targets, attaches to the page the agent last opened or navigated (it follows new tabs), runs `Page.startScreencast`, and writes JSON lines. Each frame is acknowledged only after the frame interval, so Chromium sends no more than that. It never sends input to the page.
- `BrowserLiveHub` keeps one relay per session: started by the first reader, shared, replaying the last event to new readers, stopped 10 s after the last reader leaves or when the environment stops, resets or is deleted, restarted with backoff (2 s doubling to 30 s) if it ends while readers remain, at most 4 per owner. It also caps the rate itself, keeping the newest frame.
- Config `browser.liveFps` (1 to 10, default 4) sets the frame cap.
- The sandbox key stays in the API (envd calls go through the service); nothing in the sandbox is reachable from outside.

## Verified (2026-11-27, dev Agentry Sandbox, throwaway sandboxes deleted)

- Browser image `ghcr.io/fakhrulfaiz/agentry-sandbox-browser:1`: Playwright MCP started with the new command, `browser_navigate` to example.com, a new tab, then Wikipedia. The hub delivered `idle not_started`, then frames for example.com, the new tab's `about:blank` and Wikipedia (17 frames in about 7 s); the saved frame is a 1280x720 JPEG.
- Standard image `ghcr.io/fakhrulfaiz/agentry-sandbox:1`: the relay answered `idle no_browser`.
- The HTTP route itself is covered by `tests/gateway-browser-live.spec.ts` with a fake relay; it was not run live through a running API (no dev server in this task).
