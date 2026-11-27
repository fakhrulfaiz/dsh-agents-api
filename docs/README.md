# Docs

Package-local reference and change notes for `@agentry/api`.

## Reference

| Page | Summary |
| --- | --- |
| [2026-11-26-turn-changes.md](changes/2026-11-26-turn-changes.md) | Changed files per turn with diffs (`/changes`, `/turns/{id}/changes[/{index}]`): DSH recorder for local chats, a shadow git repository inside the sandbox for sandbox chats; memory only |
| [2026-11-26-office-render.md](changes/2026-11-26-office-render.md) | `GET /agents/sessions/{id}/renders/pdf/{path}`: Office files converted to PDF by DSH's `officeToPdf` in the API process |
| [http-api.md](http-api.md) | Agents API routes, create/stream input, function-tool and approval wire contracts, live model and effort changes, scheduled tasks, slash commands |

## Changes

| Note | Summary |
| --- | --- |
| [2026-11-27-environment-create-background.md](changes/2026-11-27-environment-create-background.md) | `POST /agents/environments` on the sandbox provider answers `pending` at once and sets up in the background; timed-out creates adopt the sandbox; delete during setup; interrupted setups fail |
| [2026-11-27-projects.md](changes/2026-11-27-projects.md) | Owner-scoped Project CRUD, archive/unarchive, and the 409 `project_has_sessions` delete guard |
| [2026-11-27-browser-takeover.md](changes/2026-11-27-browser-takeover.md) | Browser take-over: `/sessions/{id}/browser/control` and `/browser/input`, input through the relay, agent's browser tools wait during control, 10 fps default |
| [2026-11-27-browser-live.md](changes/2026-11-27-browser-live.md) | Live browser view: `/sessions/{id}/browser/live` SSE frames from a CDP screencast relay inside the sandbox, idle reasons |
| [2026-11-26-browser.md](changes/2026-11-26-browser.md) | Web browser for agents: `browser` agent field, Playwright MCP inside the sandbox through the envd stdio bridge, no host browser |
| [2026-11-26-durable-subagents.md](changes/2026-11-26-durable-subagents.md) | Subagent list, turns, items and images rebuilt from the child Session logs after a restart; `model` on the subagent resource; subagent approvals on the parent session with `subagent_id` |
| [2026-11-26-owner-scoped-schedule-tools.md](changes/2026-11-26-owner-scoped-schedule-tools.md) | In-chat `schedule_*` tools shadowed per session with owner-scoped copies; other owners' and ownerless tasks look like unknown ids |
| [2026-11-26-tool-images.md](changes/2026-11-26-tool-images.md) | Images from tool results: `images` on `function_call_output` items, `timg_` file ids served by the files content route |
| [2026-11-26-session-metadata-merge.md](changes/2026-11-26-session-metadata-merge.md) | `metadata_merge` on session update (atomic, `null` deletes a key) and `metadata[key]=value` list filter |
| [2026-11-26-stream-items.md](changes/2026-11-26-stream-items.md) | The session stream carries the full item log (`<n>.<sub>` item frame ids), live-only `subagent.*` events, attachment file ids on streamed user messages, and assistant text without the reasoning prefix |
| [2026-11-27-composio-relay.md](changes/2026-11-27-composio-relay.md) | Local MCP relay in front of Composio: instant `initialize`, cached `tools/list`, one shared upstream session; `AGENTRY_COMPOSIO_RELAY=off` |
| [2026-11-27-fast-session-create.md](changes/2026-11-27-fast-session-create.md) | Session create answers before the agent (and its MCP connections) is set up; queued first message, waiting requests, `failed` + 409 `session_setup_failed` on a setup failure |
| [2026-11-23-agentry-general-agent.md](changes/2026-11-23-agentry-general-agent.md) | Agentry identity preset, per-agent skills and installs, command allow-list, Composio grants and connect requests |
| [2026-11-10-redact-mcp-secrets.md](changes/2026-11-10-redact-mcp-secrets.md) | MCP `headers` and `env` values returned masked as `***` by every session and saved-agent response and SSE event; storage and recovery keep real values |
| [2026-11-10-attachments.md](changes/2026-11-10-attachments.md) | Chat file attachments: `/agents/files` upload, content, and delete; `input_image` / `input_file` parts; workspace `uploads/` copy; item parts; TTL sweeper; `FileStore` seam |
| [2026-11-10-slash-commands.md](changes/2026-11-10-slash-commands.md) | `GET /agents/commands` catalog, `POST /agents/sessions/{id}/commands/{name}` with a 409 `session_busy` gate, and the `slash_command` item projected from `command/run` and `command/done` |
| [2026-11-09-scheduled-tasks.md](changes/2026-11-09-scheduled-tasks.md) | Owner-scoped `/agents/schedules` routes over the Host schedule service; ownership derived from the target session; deliveries resume Agentry sessions; scheduled prompts in the chat history; `this_session` prompt guidance |
| [2026-11-09-openapi-contract.md](changes/2026-11-09-openapi-contract.md) | OpenAPI 3.1 contract with full schemas, `routeTable()`, and the drift and schema-validation tests |
| [2026-11-09-approvals.md](changes/2026-11-09-approvals.md) | Approvals and user questions as `approval` required actions with `approval_response` input; live `model` / `reasoning.effort` updates; create passes the effort |
| [2026-11-08-durable-history.md](changes/2026-11-08-durable-history.md) | Items, turns, and SSE replay derived from the Session log; restart recovery; `sessions.body` (migration 0002); status written to the index |
| [2026-11-08-api-keys-mode.md](changes/2026-11-08-api-keys-mode.md) | `apiKeys` auth mode with hashed named keys and `pnpm keys:create`; `workspaces` required; session update writes the store first |
| [2026-11-08-postgres-store.md](changes/2026-11-08-postgres-store.md) | Agents, templates, environments, and the session index in Postgres with forward-only migrations; owner-scoped routes; local `EnvironmentProvider`; Codebox config rejected |
| [2026-11-08-keycloak-auth.md](changes/2026-11-08-keycloak-auth.md) | `apiKey` replaced by an `auth` block: Keycloak JWT verification in production, a fixed dev key in development |
| [2026-09-23-sandbox-rejected.md](changes/2026-09-23-sandbox-rejected.md) | `environment.type: "sandbox"` is an error; the default environment is a local directory |
| [2026-09-18-agents-api-parked-function-tools.md](changes/2026-09-18-agents-api-parked-function-tools.md) | Parked wire function tools (design note carried over from the DSH checkout) |
