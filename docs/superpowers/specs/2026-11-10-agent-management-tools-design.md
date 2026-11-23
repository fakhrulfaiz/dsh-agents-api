# Agent management tools and the create-agent skill (design)

Status: 2026-11-10, draft for review. Not implemented. Lives in `dsh-agents-api` (Agentry's own backend); nothing here changes DeepSeek's harness.

## Goal

Let the model create and look up saved agents from inside a chat, guided by one skill: the user describes a task, the agent picks a model, instructions and the narrowest set of tools, shows the draft, and saves it. The saved agent then appears on the web app's Agents page and can be chosen for new chats.

## Understanding

- Saved agents already exist (`/agents` routes, `OwnedCollection<OAIAgent>` in the store, scoped per owner). There is no model-facing way to manage them today.
- Agent-scoped Host tools are the established seam: `buildAgentSetup` (`src/gateway.ts`) already calls `applyHostToolsRestrict`, `mountScheduleGuidance`, `mountFunctionTools` and `mountMcpTools` on the session's `agentCtx`.
- Per-agent skills are out of scope. This adds one skill for everyone, not a `skills` field on agents.
- Tools added here show up in `GET /agents/tools` and can be masked with `host_tools`.

## Tools

Registered by a new `mountAgentTools(agentCtx, { owner, store, models })` in `src/mount-agent-tools.ts`, called from `buildAgentSetup` after `mountScheduleGuidance` (the owner is passed down from `provisionSession`/resume). All results are short JSON strings.

| Tool | Input | Result |
|---|---|---|
| `agent_tools` | none | `{ tools: [{ name, description }], mcp_servers: [{ server, tool_count, sample }] }`: the Host tools visible to this session (what an agent could be allowed) and the MCP servers behind some of them, grouped from the `mcp__<server>__<tool>` names. Read only. |
| `agent_list` | `limit?` (default 20, max 100) | `[{ id, name, model, summary }]` for the owner's agents. Read only. |
| `agent_get` | `id` | The agent's name, model, instructions, `host_tools`, `multi_agent`, `metadata`. Read only. |
| `agent_create` | `name`, `instructions`, `model?`, `tools_allow?` (Host tool names), `subagents?` (max concurrent), `apps?` (connector slugs) | `{ id, name }` |
| `agent_update` | `id` plus any of the `agent_create` fields | `{ id, name }` |

No delete tool in this version.

## Safety rules (enforced in the tools, not by the prompt)

- **Owner scope:** every call uses the session's owner; another owner's id answers "not found".
- **No privilege escalation:** `tools_allow` must be a subset of the Host tools this session can see (the `agent_tools` list). Unknown or unseen names fail with a clear message. There is no input for wire `tools` (MCP servers, function tools), `credential_id` or headers, so no secret or new server can be attached through a tool.
- **No recursion:** `tools_allow` cannot include any `agent_*` tool, and a created or updated agent always gets `host_tools.deny` including `agent_create` and `agent_update` unless the owner's own agent already had them. This stops agents from creating ever more capable copies of themselves.
- **Approval before writes:** `agent_create` and `agent_update` require user approval through the Host tool approval path, showing the name and instructions. Read tools do not.
- **Validation shared with the routes:** the tools call the same functions the HTTP routes use (`materializeAgent`, `validateHostTools`, model resolution) via a small shared `src/agent-service.ts`, so both paths accept and reject the same input. `model` must resolve through the Host LLM config; omitted means the session's current model.
- **Limits:** instructions at most 20,000 characters; name at most 80; apps are slugs matching `^[a-z0-9][a-z0-9_-]{0,63}$` stored as `metadata.connectors` (comma-separated); at most 100 saved agents per owner.

## The skill

`skills/create-agent/SKILL.md` in this repo, mounted in the profile's host skill layer the way `skill-office` is (`cordis.patch.yml`, a skill directory plugin; the exact plugin and config key are to confirm). The model reads it when asked to create or adjust an agent (and the user can run `/create-agent`). It tells the model to:

The full text is `skills/create-agent/SKILL.md` (drafted with this spec). In short it is a guided interview, not a one-shot:

1. **Check first:** `agent_list`; offer to adjust a close match instead of copying it.
2. **Ask** with the Host's `ask_user_question` tool (plain chat if it is absent): the job, what the agent may do, what it must never do, how it should answer; then propose a name.
3. **Survey:** `agent_tools` for tools and MCP servers, explained by purpose. For Composio, check connections with `COMPOSIO_MANAGE_CONNECTIONS` action `list` only (the default `add` creates a link). Report three lists: connected and useful, connected but probably not needed, not connected but would help.
4. **Ask what to include:** multi-select over the connected apps and MCP servers, saying honestly that "include" means a preference (a soft limit), not a lock. For a missing app, offer to connect it; only after a yes call `COMPOSIO_MANAGE_CONNECTIONS` for the link, wait for the user, re-check with `list`. With no MCP at all, say apps cannot be listed here and point to the Connectors page.
5. **Choose the smallest tool set** (read-only by default; writes, shell, web and subagents only when the job needs them), explain it, write a short brief (role, how to work, boundaries, output; under about 400 words, no keys or tool lists).
6. **Show the full draft, get a yes, then** `agent_create`; report what it can use and where to find it. Changing an agent goes `agent_list`, `agent_get`, a before/after, a yes, `agent_update` with only the changed fields.

It never asks the model to handle keys, add servers, or save without confirmation. A system-prompt section is not needed beyond the skill. The `apps` list the model sends becomes `metadata.connectors`, the soft per-agent app limit the web app already reads.

## Files

New: `src/mount-agent-tools.ts`, `src/agent-service.ts`, `skills/create-agent/SKILL.md`, tests. Changed: `src/gateway.ts` (mount call, pass owner), `src/types.ts` if shared types move, `cordis.patch.yml` (skill directory), `docs/http-api.md` (tool list under `GET /agents/tools`), `CHANGELOG.md`, `AGENTS.md`.

## Web app impact

None required. The Agents page already lists, edits and deletes agents the model creates; chat shows these as ordinary tool calls and approvals.

## Testing

Unit tests with a fake store and fake `agentCtx`: owner scoping; the subset rule (unseen name rejected, `agent_*` rejected); recursion denies added; approval required for writes and not for reads; validation parity with the routes; limits. One integration test that a session lists the five tools in `GET /agents/tools`.

## Out of scope

Deleting agents, per-agent skills, attaching MCP or function tools, sharing agents between owners, versioning.

## Open items to verify before the plan

- How a Host tool declares "needs approval" in this harness (the approval path in `src/approvals/`).
- The Host API for listing the tools visible to `agentCtx`, and whether `host_tools` masks apply to tools registered in the setup callback.
- The skill directory plugin and config key for the profile.
- Whether the owner id is available in `buildAgentSetup` on resume (it is passed for create; resume reads the stored row).
