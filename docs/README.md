# Docs

Package-local reference and change notes for `@agentry/api`.

## Reference

| Page | Summary |
| --- | --- |
| [http-api.md](http-api.md) | Agents API routes, create/stream input, function-tool and approval wire contracts, live model and effort changes, scheduled tasks, slash commands |

## Changes

| Note | Summary |
| --- | --- |
| [2026-11-26-owner-scoped-schedule-tools.md](changes/2026-11-26-owner-scoped-schedule-tools.md) | In-chat `schedule_*` tools shadowed per session with owner-scoped copies; other owners' and ownerless tasks look like unknown ids |
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
