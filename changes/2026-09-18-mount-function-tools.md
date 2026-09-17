# Mount wire function tools (2026-09-18)

## Summary

Wire `type: "function"` tools on Agents API agents are mounted into the Host agent scope. When the model calls one, the gateway parks Host execution, surfaces `requires_action` / `required_actions`, and completes the call only after the client posts a tool result — producing a real Host `tool/result` instead of a synthetic user follow-up.

## Wire contract

1. Create a session with `agent.tools: [{ type: "function", name, description?, parameters? }]`.
2. Stream until `agent.session.requires_action` (or read `session.required_actions`).
3. Post `agent.session.input.tool_result` with `turn_id`, `call_id`, and either `success: true` + `output` or `success: false` + `error`.
4. Legacy alias: `agent.session.input.function_call_output` maps to a successful completion.

## Stacking with profile tools

Harness profile tools (bash, web_fetch, …) remain available. Scoped wire functions are additive; a same-name wire tool shadows the profile global for that session.

## Deferred

MCP, `web_search`, `programmatic_tool_calling`, `tool_search`, and `defer_loading` are rejected at create time. Use the Host profile for those capabilities until a later change mounts them.
