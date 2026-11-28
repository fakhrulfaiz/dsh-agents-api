# Ask Agentry: the Agentry tools, the built-in Library in the API, and the `agentry` agent (2026-11-28)

Plan: `agentry-web/docs/superpowers/plans/2026-11-28-ask-agentry.md`.

## Agentry tools (`src/mount-agentry-tools.ts`)

Mounted on every session's agent scope before the `host_tools` mask (like the `agent_*` tools), so any agent may use them unless its mask hides them. Every call is scoped to the session owner and uses the same helpers as the HTTP routes (`src/projects.ts`, now shared with `/agents/projects`; `createSavedAgent`; the Library classes).

| Tool | Asks first | What it does |
|---|---|---|
| `project_list` | no | The owner's projects (`status` active by default) with agent, environment, folder and `/?project=<id>` link. |
| `project_create` | yes | `name`, optional `agent_id` (a saved agent or a built-in), `environment_id`, `directory`, `pinned`. Unknown or foreign agent and environment ids are refused. |
| `project_update` | yes | The same fields by `id`; `null` clears the agent or environment; a folder-only change keeps the environment. |
| `chat_move_to_project` | yes | Moves this chat (or `session_id`) into `project_id`, or out with `null`, through the same settings path as `POST /agents/sessions/{id}`. |
| `library_search` | no | Built-in Library plus the owner's sources, by words in the name or description; each hit has its `ref`. |
| `library_add` | yes | Saves an agent from a `ref`: built-in draft, or the source file fetched and parsed like `POST /agents/import`. Named "Name (Source)" (then numbered) when the name is taken; `metadata.library_source`/`library_ref` set as in the web app. Wire tools from a JSON draft are never added; app grants are clamped to the caller's. |
| `environment_list` | no | Every environment of the owner with provider, live state, template, `chat_only` for per-chat sandboxes, `/sandboxes/<id>` link. |

Asking is the same `tools/pre-execute` → `{ kind: 'ask' }` path as the agent and sandbox tools; the approval bridge shows it as an approval card (`agent.session.input.approval_response`). The card text names projects, environments and agents by name. Templates, creating and starting sandboxes stay with the `sandbox_*` tools (`sandbox_templates`, `sandbox_create` with a `template_id` already makes a named environment), saved agents with `agent_*`, schedules with the owner-scoped `schedule_*`; no `template_list` or `environment_create` was added.

## Built-in Library in the API (`src/agent-import/builtin-library.ts`)

The built-in agent files (adapted from ECC, with `NOTICE.md`) moved from the web app to `src/agent-import/agent-library/`; the build copies them to `lib/agent-library` (and the package ships them). `GET /v1/agents/library/builtin` serves them parsed with the import parser (which now also keeps `icon`/`color` in `metadata`): `ref` (`Agentry:<file>`), `source`, `name`, `slug`, `description`, `origin`, avatar, `browser`/`subagents`/`apps`, `text` and `draft`. The web app reads this instead of its own bundle.

## Built-in agent `agentry` (`src/builtin-agents.ts`)

- Not stored per owner. `GET /v1/agents` lists it first on the first page with `built_in: true`; `GET /v1/agents/agentry` reads it; update and delete answer 409 `agent_built_in`; a session may use `agent_id: "agentry"` (an `agent` overlay, such as the web app's model, still applies).
- Model: the deployment default (`agentDefaultModel`). No connected apps (no Composio connection at start), no browser.
- Tools (`host_tools.allow`): the Agentry tools, `agent_*`, `sandbox_list`/`sandbox_templates`/`sandbox_create`/`sandbox_start`, `schedule_*`, `read`/`glob`/`grep`, `ask_user_question`, `web_search`/`web_fetch`. No shell, no file writes, no sandbox commands or deletes.
- Instructions: understand the goal (2–3 questions at most; 3 ideas when the user does not know what to build), look with the list tools first and reuse what exists, propose a short plan and wait for a yes, then create in order (environment, agent, project, schedule) through the approval cards, finish with relative links (`/?project=`, `/sandboxes/`, `/agents/`, `/scheduled/`) and the next step. Never invent ids; keep answers short.

## Masks and scope tools (fix)

DSH's `tools.restrict` masks only the preset's (global) tools and throws on any other name; tools a session registers on its own agent scope (agent, Agentry, sandbox and skill tools) always stay visible. A `host_tools` mask naming one of them failed the whole session setup; this hit every agent saved by `agent_create`, which denies `agent_create`/`agent_update`. Now (`withToolFilter` and `applyHostToolsRestrict` in `src/host-tools.ts`):

- the scope mounts go through a context whose `tools.register` skips names in `host_tools.deny` (and, for built-in agents only, names missing from `host_tools.allow`); saved agents with an `allow` list keep every scope tool, as before;
- the names seen there are left out of the mask passed to `tools.restrict`.

For the built-in assistant, `agent_tools` and `agent_create` check against the whole Host catalog (not the assistant's own few tools), so the agents it creates can have files, shell and web; its instructions say to leave `tools_allow` out unless the user asks. It also asks before `schedule_create` and `schedule_edit` (`askSchedules`), which DSH's own schedule tools never do; other agents' schedule tools are unchanged.

## Live check (2026-11-28)

A chat with `agent_id: "agentry"` on the dev stack ("I want to build a small recipe website, set it up for me"): it listed projects, environments, agents and the Library, asked two questions (stack; reuse "Test sandbox"), proposed a plan, then after "yes" created the agent and the project (`recipe-site` folder in Test sandbox) through two approval cards and answered with links. "Remind me every Monday at 9am to plan meals" asked for the time zone and created a weekly schedule through an approval card. Everything it created was deleted afterwards.

## Limits

- A project's folder is made when the first chat in the project starts (unchanged).
- `library_search` reads the owner's sources through the 10-minute listing cache; an unreadable source is named in `unreadable_sources`.
