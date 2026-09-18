# Host tool catalog and restrict (2026-09-18)

## Summary

Clients can list Host profile tools with `GET /agents/tools` and mask them per agent or session with the DSH extension field `host_tools: { allow?, deny? }`, which maps to `agentCtx.tools.restrict()` on session create. Wire `agent.tools` remains additive `type: "function"` only.

## Wire

1. `GET /v1/agents/tools` → `{ object: "list", data: [{ name, description, parameters, source: "host" }] }` from `ctx.tools.schemas()`.
2. Plugin `inject` includes `tools` so the gateway context holds the Host catalog service (without it, `schemas()` throws and `dsh-host-webserver` answers empty HTTP 400).
3. Persist `host_tools` on `POST /agents` / `POST /agents/{id}` and on session `agent` / `agent_id` overlays.
4. Empty `host_tools: {}` is rejected. Unknown names fail when `restrict()` runs at session create.
5. Route order keeps `/agents/tools` ahead of `/agents/:agent_id`.

## Related

Host foundation: `@deepseek-ai/dsh-tools` `schemas()` and `restrict()`. Official OpenAI `web_search` / MCP mount remain rejected on the wire.
