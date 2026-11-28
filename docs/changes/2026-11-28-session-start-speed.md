# Session start speed: measurement and parallel MCP mounts (2026-11-28)

## Problem

Session create already answers early (see `2026-11-27-fast-session-create.md`), but the first message waits for background setup. `@deepseek-ai/dsh-mcp-client` blocks plugin activation on the first connection and `tools/list`, and `mountMcpTools()` mounted each server with `await` in a loop, so two slow servers cost their sum. We had no per-server numbers from the dev setup, and the Composio relay already covered the one server we knew was slow.

## Decision

- `mountMcpTools()` starts every MCP plugin fiber in tool order and awaits them together. Cordis starts a fiber when `ctx.plugin()` is called (`vendor/cordis/src/registry.ts`), so the connections now overlap; setup time tracks the slowest server.
- The DSH config path, `allowed_tools` guards and error messages are unchanged. Guards are installed after all mounts succeed; no tools execute during setup. If one mount fails, the existing agent-context rollback disposes the agent scope and with it the other fibers.
- Duplicate `server_label` values are still rejected before any fiber starts.
- With `AGENTRY_DEBUG_TIMING=1`, one stderr line per setup reports elapsed milliseconds per server label and total mount time, for example:
  `[agentry-timing] mcp mounts: docs=123ms, composio=456ms; total=457ms`
  Only labels and numbers are logged — never URLs, headers, env values or workspace paths. The flag is off by default.

## Measurement

Recipe (not yet measured against this change — see below):

1. Start the dev stack with the flag: `AGENTRY_DEBUG_TIMING=1 scripts/dev.sh` (start Agentry Sandbox first when `AGENTRY_SANDBOX_URL` is set, as the launcher says).
2. Create a lean session: a saved agent with no `mcp` tools whose Composio grants allow no apps (so the owner connector is skipped), for example `POST /v1/agents/sessions` with `{"agent":{"instructions":"Reply briefly."},"input":"Say OK"}` and headers `Authorization: Bearer $AGENTRY_DEV_KEY`, `OpenAI-Beta: agents=v1`, `content-type: application/json`. Time create to first reply.
3. Create a full session the same way with the owner's normal agent (its Composio connector plus any other configured MCP tool). Time create to first reply and note the `[agentry-timing]` line in the API process output.
4. Read `Input` and `Cached` token counts for the first turn in the web app's Trajectory Inspector (they come from `input_tokens` and `input_tokens_details.cached_tokens` on the turn). A single run is a sample, not a benchmark claim; repeat a few times if the numbers matter.

Status: **not measured for this change.** A dev API was running on `127.0.0.1:3080` from a process started before this change and without the timing flag. Restarting that shared process would have interrupted other work, so no live numbers were invented. The timing output is covered by unit tests, and the recipe above is ready for a deliberate restart.

## Deferred

- Generic caching of every MCP server's `tools/list`. The Composio relay already caches its upstream list and warms it in the background (`2026-11-27-composio-relay.md`); other servers need a DSH client option or our own wrapper and per-owner invalidation. Revisit if the timing lines show another slow server.
- Cross-session prompt-prefix stability. The web Trajectory already shows `Cached` tokens. Our agent identity, instructions and workspace guidance are static sections placed after the persona prefix; the volatile parts of the prompt (runtime context, tool schemas) belong to DSH. Changing them needs an upstream DSH change, not a patch to the pinned checkout.
