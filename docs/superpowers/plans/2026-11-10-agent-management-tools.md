# Agent Management Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model five agent-scoped Host tools (`agent_tools`, `agent_list`, `agent_get`, `agent_create`, `agent_update`) plus a `create-agent` skill, so a chat can create and look up the owner's saved agents.

**Architecture:** Shared validation and persistence live in `src/agent-service.ts`, used by both the HTTP routes and the tools. `src/mount-agent-tools.ts` registers the tools on the session's `agentCtx` from `buildAgentSetup`, with the owner passed in; writes ask for approval through a `tools/pre-execute` handler. The skill is a `SKILL.md` in this repo, mounted through the existing skill provider's `customSkillDirs`.

**Tech Stack:** TypeScript, Cordis/DSH plugin APIs, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-agent-management-tools-design.md`

## Global Constraints

- Nothing under `deepseek-harness/` or `dsh-pinned/` is edited.
- Every tool call is scoped to the session owner (`SessionIndexRow.ownerId`); another owner's id reads as not found.
- No tool input accepts wire `tools`, `credential_id`, headers or URLs.
- Limits: name at most 80 characters; instructions at most 20,000; apps match `^[a-z0-9][a-z0-9_-]{0,63}$` and are stored as `metadata.connectors` (comma-separated); at most 100 saved agents per owner; `agent_list` default 20, max 100.
- `tools_allow` is a subset of the Host tool names the calling session can see and never contains an `agent_*` name; created or updated agents always get `host_tools.deny` containing `agent_create` and `agent_update` unless the owner's existing agent already allowed them.
- Commits: author `fakhrulfaiz <fakhrulfaiz2003@gmail.com>`; no `Co-Authored-By` or AI attribution.
- Run `pnpm typecheck` and `pnpm test` (they run the DSH pin check first).

## Verified while planning

- `buildAgentSetup(resolved, pending, cwd)` in `src/gateway.ts` has no owner; `provisionSession` has `owner`, and `resumeSession(row)` has `row.ownerId`.
- Tools are registered with `agentCtx.tools.register(definition)`; a definition has `name`, `description`, `parameters`, `output: { schema, render }` and `execute(args, exec)` (see `createParkedFunctionTool`).
- Approval: a `tools/pre-execute` event handler returns `{ kind: 'ask', reason?, displayReason? }`; `src/approvals/approval-bridge.ts` already maps asks to the Agentry `approval` required action.
- The skill provider (`@deepseek-ai/dsh-skill-filesystem`) scans `Config.customSkillDirs` (rank 300) for `<name>/SKILL.md` bundles.

## Review Focus

- A model asks for `tools_allow` names it cannot see: rejected, nothing saved.
- A model asks to include `agent_create` in `tools_allow`: rejected.
- Two owners with the same agent id: each sees only their own.
- The 101st agent: refused with a clear message.
- The user denies the approval: nothing is saved and the tool result says so.

---

### Task 1: Shared agent service

**Files:**
- Create: `src/agent-service.ts`
- Modify: `src/gateway.ts` (`createAgent`, `updateAgent` routes call the service)
- Test: `tests/agent-service.test.ts`

**Interfaces:**
- Produces:
  - `type AgentInput = { name: string; instructions?: string; model?: string; toolsAllow?: string[]; subagents?: number; apps?: string[] }`
  - `validateAgentInput(input: Partial<AgentInput>, visibleTools: ReadonlySet<string>): string | undefined` — returns an error message or `undefined`; enforces the limits and the subset/`agent_*` rules from Global Constraints.
  - `toAgentParams(input: AgentInput, existing?: OAIAgent): CreateAgentParams` — maps to `host_tools.allow`, `host_tools.deny` (recursion deny rule), `multi_agent`, `metadata.connectors`.
  - `createSavedAgent(store, owner, params): Promise<OAIAgent>` and `updateSavedAgent(store, owner, id, params): Promise<OAIAgent | undefined>` — both enforce the 100-agent cap on create and reuse `validateMountableTools`, `validateHostTools`, `materializeAgent`.

- [ ] **Step 1: Write the failing tests** — `validateAgentInput`: rejects an 81-character name, 20,001-character instructions, a `tools_allow` name outside `visibleTools`, any `agent_*` name, a bad app slug; accepts a valid input. `toAgentParams` for a new agent: `host_tools.deny` equals `['agent_create','agent_update']`, `metadata.connectors === 'gmail,github'` for `apps: ['gmail','github']`. `createSavedAgent` with a fake store holding 100 agents for the owner throws "agent limit reached"; another owner is unaffected.
- [ ] **Step 2: Run** `pnpm vitest run tests/agent-service.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the four functions in `src/agent-service.ts`; refactor the two route handlers in `gateway.ts` to call `validateMountableTools`/`validateHostTools` through the service without changing their HTTP behavior.
- [ ] **Step 4: Run** the new tests and the existing gateway agent-route tests (`pnpm vitest run tests -t agent`) — Expected: PASS.
- [ ] **Step 5: Commit** `feat: shared agent service for routes and tools`.

### Task 2: The five tools and the approval handler

**Files:**
- Create: `src/mount-agent-tools.ts`
- Test: `tests/mount-agent-tools.test.ts`

**Interfaces:**
- Consumes: Task 1's `validateAgentInput`, `toAgentParams`, `createSavedAgent`, `updateSavedAgent`.
- Produces: `mountAgentTools(agentCtx: Context, deps: { owner: OwnerId; store: Store }): void` — registers `agent_tools`, `agent_list`, `agent_get`, `agent_create`, `agent_update` (each a `ToolDefinition` returning a short JSON string) and a `tools/pre-execute` handler that returns `{ kind: 'ask', reason, displayReason: { en } }` for `agent_create` and `agent_update` (showing name and a 200-character instruction excerpt) and `{ kind: 'allow' }` otherwise. `agent_tools` returns `{ tools: [{ name, description }], mcp_servers: [{ server, tool_count, sample }] }` from `agentCtx.tools.schemas()`, excluding `agent_*` tools from `tools`; `mcp_servers` groups names of the form `mcp__<server>__<tool>` by `server` (`tool_count` = number of tools, `sample` = up to three tool names).

- [ ] **Step 1: Write the failing tests** with a fake `agentCtx` (records registered tools and the event handler) and a fake store: five tools registered; `agent_create` with an unseen tool name returns an error string and the store is unchanged; with `tools_allow: ['agent_create']` it errors; a valid call saves and returns `{ id, name }`; `agent_get` of another owner's id returns "not found"; `agent_list` clamps `limit` to 100; the handler asks for create/update and allows list/get/tools; `agent_tools` given schemas named `read_file`, `mcp__composio__COMPOSIO_SEARCH_TOOLS`, `mcp__composio__COMPOSIO_MANAGE_CONNECTIONS` and `mcp__other__lookup` returns `mcp_servers` of `composio` (`tool_count` 2) and `other` (`tool_count` 1), and with no MCP tools returns `mcp_servers: []`.
- [ ] **Step 2: Run** `pnpm vitest run tests/mount-agent-tools.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `mountAgentTools`. Input schemas are JSON Schema objects with the Global Constraints limits; tool errors are returned as results, not thrown, so the model can correct itself.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat: agent management tools`.

### Task 3: Mount in sessions

**Files:**
- Modify: `src/gateway.ts` (`buildAgentSetup` gains an `owner` parameter; `provisionSession` passes `owner`, `resumeSession` passes `row.ownerId`; calls `mountAgentTools` after `mountScheduleGuidance`)
- Test: `tests/gateway-agent-tools.test.ts`

**Interfaces:**
- Consumes: `mountAgentTools(agentCtx, { owner, store })`.
- Produces: `buildAgentSetup(resolved, pending, cwd, owner)`.

- [ ] **Step 1: Write the failing test** — create a session through the gateway test harness (follow `tests/` neighbors for session creation) and assert `GET /agents/tools?session_id=<id>` lists the five tool names; with `host_tools: { deny: ['agent_create'] }` on the agent, `agent_create` is absent; a resumed session still lists them.
- [ ] **Step 2: Run** `pnpm vitest run tests/gateway-agent-tools.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the signature change and both call sites. Mount the tools before `applyHostToolsRestrict` runs so the agent's own mask can hide them: move `applyHostToolsRestrict` below `mountAgentTools` and confirm the existing function-tool and MCP ordering still behaves.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: mount agent tools in sessions`.

### Task 4: The create-agent skill, profile config and docs

**Files:**
- Create: `skills/create-agent/SKILL.md`
- Modify: `cordis.patch.yml` (skill provider entry with `customSkillDirs`), `docs/http-api.md` (tool list note), `CHANGELOG.md`, `AGENTS.md` (backlog item 5 and the tools note)
- Test: `tests/create-agent-skill.test.ts`

**Interfaces:**
- Produces: a skill named `create-agent` (frontmatter `name`, `description`; user-invocable) following the five steps in the spec.

- [ ] **Step 1: Write the failing test** — read `skills/create-agent/SKILL.md` (a full draft already exists in the repo from the spec stage; review it as part of this task) and assert: frontmatter has `name: create-agent`, a non-empty `description` and `user-invocable: true`; the body names `ask_user_question`, `agent_tools`, `mcp_servers`, `agent_list`, `agent_get`, `agent_create`, `agent_update` and `COMPOSIO_MANAGE_CONNECTIONS`; it says to use action `list` for status checks and not the default `add`; it describes the three groups (connected and useful, connected but probably not needed, not connected but would help); it tells the model to show a draft and get a yes before `agent_create`; it covers the no-MCP case (Connectors page); and it never tells the model to handle keys, credentials, `credential_id` or to add servers.
- [ ] **Step 2: Run** `pnpm vitest run tests/create-agent-skill.test.ts` — Expected: PASS against the draft, or FAIL naming the missing phrase; fix the skill text for any miss, do not weaken the test.
- [ ] **Step 3: Review the draft against the live tool behavior** once Tasks 2 and 3 exist (for example, the `agent_tools` result field names and the approval prompt wording) and adjust `SKILL.md`. Add the `customSkillDirs: [<repo>/skills]` entry to `cordis.patch.yml` (check whether the profile already mounts `@deepseek-ai/dsh-skill-filesystem` and extend that entry instead of adding a second).
- [ ] **Step 4: Run** the test and `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: create-agent skill and docs`.

### Task 5: Live check (manual, with the user)

- [ ] **Step 1:** Start the backend with the new profile; in a chat say "create an agent that reviews pull requests"; confirm the model calls `agent_tools`, shows a draft, asks for approval, and the agent appears in `GET /agents` and on the web Agents page with `host_tools.deny` containing the two write tools. Record any failure; do not claim success unchecked.
