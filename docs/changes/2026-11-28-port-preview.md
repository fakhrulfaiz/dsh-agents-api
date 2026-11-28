# Sandbox port preview (2026-11-28)

The web app shows an app running inside a sandbox (`python -m http.server`, `vite`, Flask) in the chat's side panel.

Path: browser, web app `/preview/<token>/...`, this API, the sandbox service `/v1/sandboxes/{id}/ports/{port}/...`, the port.

- `GET /v1/agents/environments/{environment_id}/ports` runs `cat /proc/net/tcp /proc/net/tcp6` in the sandbox (`src/sandbox/ports.ts`) and answers `{ object: "list", data: [{ port }] }`. Only ports bound to all addresses are listed, so Chromium's DevTools port and other loopback-only servers stay out of the picker; the proxy itself reaches loopback-only servers too (the service connects from inside the sandbox), so a typed-in port works. envd's port 49983 is hidden. It starts a stopped sandbox.
- `GET|POST /v1/agents/environments/{id}/ports/{port}` and `.../ports/{port}/{path}` stream a request to the port and the response back, without buffering. Forwarded request headers: `accept`, `accept-language`, `content-type`, `content-length`, `range`, `if-none-match`, `if-modified-since`, `user-agent`. The caller's `Authorization` and cookies are never sent to the app (the service adds only its own key and the owner). The app's status and headers (including `Set-Cookie`; the web app strips it) are returned as is.
- Errors: 404 for another owner's or an unknown environment, 409 for an environment that is not a sandbox, 400 for a bad port, 501 `port_preview_unsupported` where the place cannot reach ports (everything except Docker, also over SSH; the image needs bash), 502 `port_unreachable` when nothing answers.
- Not built: WebSocket (live reload), methods other than GET and POST, E2B's own per-port hosts.
