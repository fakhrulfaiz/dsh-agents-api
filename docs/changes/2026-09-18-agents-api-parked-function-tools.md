# Agent Note: Parked client function tools on Agents API

Status: implemented

English | [中文](2026-09-18-agents-api-parked-function-tools.zh.md)

## Problem

The Agents API wire lets clients declare `type: "function"` tools and complete them with `agent.session.input.tool_result` after `requires_action`. The gateway previously stored those tool objects on the session agent resource and treated `function_call_output` as ordinary user follow-up text, so the Host never advertised the tools and never appended a real `tool/result`.

## Decision

On session create, validate that every `agent.tools` entry is a non-deferred `type: "function"` tool (other types fail loud with 400). Pass an `agents.create` `setup` that registers each function as a scoped Host tool whose `execute` parks in a per-session pending registry, sets `required_actions`, and emits `agent.session.requires_action`.

`agent.session.input.tool_result` (and the legacy alias `agent.session.input.function_call_output`) resolves that waiter only. Success returns the string output from `execute`; failure throws so the Host records a failed tool result. Profile/global tools remain visible; a same-name scoped registration shadows the global for that session.

## Alternatives considered

**Submit function results as user follow-up text.** Keeps the gateway thin but leaves the Host tool pipeline and Session log wrong: the model never sees a `tool/result` bound to the call id.

**Mount MCP / web_search from the wire in the same change.** Those need Host-side providers and credentials beyond a parked client callback. Reject them at create time until a dedicated plan owns them.

**Replace profile tools with only wire tools.** The Agents API client should add application functions without removing Host capabilities the profile already composed.

## Consequences

OpenAI SDK clients can declare function tools and complete them with the official `tool_result` event. Harness profiles still own sandboxed Host tools. MCP, web search, programmatic tool calling, and deferred loading remain deferred and rejected on the wire.

Source-launch Hosts must share one `TOOL_RUNTIME_SCHEDULER` identity across tsx `paths` (src) and Cordis package loads (lib); `dsh-tools` uses `Symbol.for` for that key so parked function tools and profile tools can both `prepare`.
