# Host tool scheduler Symbol identity (2026-09-18)

## Summary

Wire function-tool turns call into the Host tool pipeline. That pipeline looks up an internal scheduler on `ctx.tools` with `TOOL_RUNTIME_SCHEDULER` from `@deepseek-ai/dsh-tools`. The key must be process-global (`Symbol.for`) so a source-launch `src` copy and a runtime-resolved `lib` copy share one identity.

## Symptom

A session that reaches a wire `type: "function"` call can append the function-call item, then fail with:

`Cannot read properties of undefined (reading 'prepare')`

The Agents API gateway mounted the tool and the model requested it. Host dispatch then read `ctx.tools[TOOL_RUNTIME_SCHEDULER]` with a different Symbol instance than the one on the live `ToolRuntime` service, so `.prepare` threw.

## Ownership

The fix lives in `@deepseek-ai/dsh-tools` (`TOOL_RUNTIME_SCHEDULER = Symbol.for('@deepseek-ai/dsh-tools.scheduler')`), not in this gateway. After changing that package, rebuild or restart the Host so both `src` and `lib` load the shared key. This package only documents the failure mode for Agents API clients and maintainers who hit it while testing wire functions.

## Related client contract

Even with a healthy Host scheduler, the client must still post `agent.session.input.tool_result` (or legacy `function_call_output`) for each `requires_action` function call. Missing that step leaves the turn parked; it does not produce this `prepare` error.
