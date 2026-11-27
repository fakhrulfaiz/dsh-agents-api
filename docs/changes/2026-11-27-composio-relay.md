# Composio relay (2026-11-27)

## Why

A new chat's first message waited about 2 seconds for the agent's Composio MCP connection (connect plus `tools/list`), because DSH's `mcp-client` blocks agent setup on it. Session create already answers early (`2026-11-27-fast-session-create.md`), but the first turn still started only after that connection.

## What changed

The API serves a small MCP relay on its own web server at `/internal/mcp-relay/<token>` and points the agent's Composio MCP tool at it instead of at `connect.composio.dev`.

- **Rewrite.** At agent setup (`gateway.ts`, before `mountMcpTools`) an HTTP MCP tool whose `server_label` is the configured Composio label (`composio.serverLabel`, default `composio`) and whose URL host is `connect.composio.dev` becomes `http://<api origin>/internal/mcp-relay/<token>` with no headers. The label is unchanged, so grants, approvals, `mountComposio` and `mountComposioAppTools` work as before. The stored session config keeps the original tool; the token lives in memory only, and the same (url, headers) pair always maps to the same token. The owner's key never appears in the URL.
- **Local answers.** `initialize` and `ping` are answered by the relay itself; notifications get 202. `tools/list` is served from a per-connector cache (served stale at once and refreshed in the background after 30 s; waits for the upstream only when nothing is cached for that cursor). Each page is also written to `~/.dsh/agentry-composio-relay/<sha256>.json` (tool list only, no key; the file name is a hash of url and headers), so a restart starts warm.
- **One upstream session per connector key.** The relay initializes against Composio once (keeping `mcp-session-id`), and every chat of that owner shares it for `tools/call` and other forwarded methods. A 404 re-initializes once and retries. JSON and SSE replies are both parsed.
- **Warm-up.** Rewriting a tool starts the upstream connect and `tools/list` in the background.
- **Failures.** With the upstream down and nothing cached, `tools/list` answers a JSON-RPC error (the connector tool is `required: false`, so the chat still starts). A failed `tools/call` returns an `isError` result with the message.
- **Access.** The route answers only peers on loopback or on the server's own address (403 otherwise) and only known tokens (404 otherwise).

## Configuration

- `AGENTRY_COMPOSIO_RELAY=off` (also `0`, `false`) restores the direct connection. Default on.
- `AGENTRY_COMPOSIO_RELAY_CACHE_DIR` overrides the cache folder (default `~/.dsh/agentry-composio-relay`).

## Measuring

Create a chat with a first message and compare the time from `POST /v1/agents/sessions` to the first `agent.session.turn.started` (or the first model request) with `AGENTRY_COMPOSIO_RELAY=off` and on. Warm, the connector wait drops from about 2 s to a few milliseconds; the first chat after an API start with no cache file still pays the upstream `tools/list` once.

## Limits

The relay is not a general proxy: only `connect.composio.dev` tools carrying the Composio label are rewritten, downstream sessions are stateless, and server-to-client requests (sampling, roots) and progress notifications are not forwarded. The tool list can be up to 30 s stale; a changed connection (a newly connected app) shows in a chat after the next refresh.
