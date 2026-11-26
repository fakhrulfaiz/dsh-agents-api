# Agentry API — agent guide

Read this first in every session. It records decisions already made so they are not re-derived or re-litigated. `CLAUDE.md` is a symlink to this file; edit `AGENTS.md`.

## What this project is

**Agentry** is a self-hosted agent product built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). This repository is **Agentry API**: a DSH plugin that serves an **OpenAI Agents API–compatible** HTTP surface (`OpenAI-Beta: agents=v1`) plus an Agentry admin API. Describe it as "OpenAI Agents API–compatible"; never put "OpenAI" in a product or package name.

- The package is `@agentry/api`. The repository folder is still `dsh-agents-api`; the repository rename to `agentry-api` is pending.
- Product family: **Agentry API** (this repo), **Agentry Cowork** (separate frontend repo `agentry-web`, not created yet), **Agentry Admin** (inside the frontend).

## Workspace layout (`~/code`)

| Path | Role | Rule |
|---|---|---|
| `deepseek-harness/` | Upstream DSH checkout | Never edit on `master`. Pin to a release tag. Upstream fixes go in a separate git worktree branch and become upstream PRs. |
| `dsh-pinned/` | Git worktree of `deepseek-harness` at tag `dsh-v0.2.2-rc.1`, built with `pnpm run build:artifacts` | `DSH_ROOT` points here. Never edit. The stale in-tree copy of this repo was deleted 2026-11-08 after its `CHANGELOG.md` and note were carried over. |
| `dsh-agents-api/` | **This repo** (future `agentry-api`) | All Agentry API work happens here. |
| `agents-api-client/` | Python smokes + Streamlit dashboard | Throwaway client; the real frontend replaces it. |

## Decisions (do not re-litigate)

1. **Plugin, not fork.** Agentry API loads as a DSH plugin inside a DSH install. DSH packages are `peerDependencies` provided by the host install; npm-published DSH versions lag `master`, so do not depend on them directly. Typecheck and test against the pinned `deepseek-harness` checkout through TypeScript paths.
2. **One profile, three surfaces.** Profile `agentry` = bundles `[dsh-base, dsh-web-app, this package]`. This package's `cordis.patch.yml` inserts only its own rows and reuses the web app's `id: webserver`. One server serves `/` (DSH web app), `/v1` (Agentry API), `/admin/v1` (Agentry admin API), and `/health`. Each route owns its auth; `dsh-host-webserver` has no server-wide auth.
3. **Hosting.** DSH + Agentry API run in **one Docker container on a VM**, on a private network behind a TLS reverse proxy. Volumes: `/data/dsh` (DSH home) and `/data/workspaces/<owner>/…`. DSH web rejects wildcard binds; bind a concrete address and set `publicUrl`.
4. **Sandbox.** The container is the outer boundary (gVisor `runsc` optional). Per-session confinement uses DSH's own `dsh-sandbox-local` (`workspace-write` on the session workspace; inside Docker expect Landlock, because `bwrap` usually lacks user namespaces). **Codebox is parked**: keep its client behind an `EnvironmentProvider` interface, disabled. **Per-session sandboxes = Agentry Sandbox** (`~/code/agentry-sandbox`, 2026-11-24): the `sandbox` provider plus a per-sandbox preset that runs DSH's SSH executor family (`dsh-fs-ssh`, `dsh-subprocess-ssh`, `dsh-sandbox-ssh`, `dsh-ptc-runtime-node`) **inside one isolated preset group** over `EnvdSshConnection` (envd transport, reconnects after a stop). This replaces the earlier "never the SSH family" rule: its three objections (whole-profile replacement, no reconnect, DSH web workspace views) are answered by the isolated group, the reconnect, and Agentry's own workspace routes reading through the provider. Do not mount the SSH family at the profile root.
5. **Users.** Single user now, built to grow. Every agent, session, environment, and workspace record carries `owner`. Workspaces live at `workspaces/<owner>/…`. Later multi-user isolation = one harness container per user behind a router.
6. **Auth and governance: three modes behind one `Authenticator` interface.** `production`: Keycloak (OIDC); the API validates access tokens (JWKS), `owner` = token `sub`, the admin API requires an admin realm role. `apiKeys`: simple self-hosting without Keycloak (`deploy/compose.simple.yml`, Task 8); named keys `agk_…` stored as `sha256:` hashes in config, created with `pnpm keys:create`; optionally combined with Keycloak. `development`: one shared `devKey`, never in production. A SQLite `Store` for the simple stack is a planned follow-up. The frontend talks to the API **only through its own backend (BFF)**; browsers never hold API credentials.
7. **Database: PostgreSQL.** Postgres stores Agentry-owned records: owners, saved agents, environments and templates, the session index (owner, agent, status, timestamps), and admin metadata. Keycloak uses its own Postgres database. The DSH Session log stays in DSH storage and remains the source of truth for model-visible history; never duplicate model requests into Postgres. Schema changes use numbered, forward-only migrations. The current JSON-file `durable-store.ts` is a stopgap to replace.
8. **Admin sees full model requests.** `/admin/v1` exposes all sessions, user messages, and the full per-turn model request (system prompt, context, tools, history) reconstructed from the DSH Session log through `dsh-session-query` (reuse the reconstruction in experimental `dsh-session-inspector`), plus live configuration through `dsh-config-editor` / `dsh-settings`.
9. **Parallelism in the product = DSH subagents** (already exposed at `/agents/sessions/{id}/subagents…`). Parallel children need disjoint file scopes.
10. **Frontend (later, separate repo).** Claude.ai-like information architecture (sidebar history and projects, chat-first pane, artifacts panel, settings sections) built with the astryx design system (`@astryxdesign/core`, `@stylexjs/stylex`, `@astryxdesign/theme-neutral`, `@astryxdesign/cli`). Copy layout and interaction patterns, never Anthropic branding (name, logo, mark, licensed fonts, exact colors). The frontend also ports DSH web features (trace/session-log inspector, tool and trajectory cards, subagent/team views, deliverables and per-turn diffs, plan/todo/goal panels, jobs and schedules) into the astryx design system. DSH is MIT: keep DeepSeek's copyright notice in files with substantial copied code. Every ported feature reads data only through Agentry API endpoints (via the BFF), never through DSH's internal remote layer, so each one needs a matching API endpoint.

## Status (update when it changes)

- Design for sub-project 1 (API hardening + admin API) and sub-project 2 (combined profile + VM container) is in progress; the spec will live in `docs/superpowers/specs/`.
- OpenAPI contract landed: `openapi/agentry.yaml` (3.1) describes every `/v1` route, body schema, the error envelope, bearer auth, and the SSE stream; `AgentsGateway.routeTable()` plus `tests/openapi-drift.spec.ts` and `tests/openapi-contract.spec.ts` keep it in sync. Change a route or wire type and the spec in the same commit. The admin API (`/admin/v1`) joins the spec when it exists: add `AdminGateway.routeTable()` to `routeSets()` in the drift test. No CI workflow in this repo by decision.
- Postgres store landed: agents, templates, environments, and the session index live in Postgres with owner scoping; the `durable-store.ts` JSON stopgap is replaced by Postgres. Items, turns, and SSE replay come from the DSH Session log (`src/history/`), sessions that were running at shutdown are resumed or marked `interrupted` at startup (`src/recovery.ts`), and live status is written to the index.
- Agent management tools landed (2026-11-10): `agent_tools`, `agent_list`, `agent_get`, `agent_create`, `agent_update` are mounted on every session, plus the `create-agent` skill from `skills/` via a second filesystem skill provider. Live verification (a real model creating an agent, and two skill providers coexisting) is open. Spec and plan: `docs/superpowers/specs/2026-11-10-agent-management-tools-design.md`, `docs/superpowers/plans/2026-11-10-agent-management-tools.md`.
- Scheduled tasks landed (backend): owner-scoped `/v1/agents/schedules` routes over the Host schedule service, deliveries resume Agentry sessions (`schedule/resolve-agent`), scheduled prompts appear as `source: "schedule"` user items, and chat-created tasks are steered to `this_session`. Ownership is derived from the target or involved session (no table). The in-chat `schedule_*` tools are owner-scoped too (2026-11-26, per-session shadows, `docs/changes/2026-11-26-owner-scoped-schedule-tools.md`). Live verification (restart delivery, second owner) is open. Spec and plan: `docs/superpowers/specs/2026-11-09-scheduled-tasks-design.md`; write-up `docs/changes/2026-11-09-scheduled-tasks.md`.
- Known gaps: subagent stream events (`agent.session.subagent.*`) are live-only and never replayed (the `/subagents` routes are rebuilt from the child logs, so they survive a restart); replayed `session` snapshots show the current configuration; timed `ask_user_question` calls are not exposed, and a subagent cannot ask a question at all (DSH refuses non-root askers with `DELEGATED_CALLER`); subagent approvals do surface on the parent session with `subagent_id` (2026-11-26); Codebox execution depends on a `dockerSandbox` service that no DSH package provides.
- Approvals: sandbox escalations, tool approvals, and user questions surface as `approval` required actions and are answered with `agent.session.input.approval_response` (`src/approvals/`); `model` and `reasoning.effort` updates, on `POST /agents/sessions/{id}` and on follow-up messages, retarget the live agent (`docs/changes/2026-11-09-approvals.md`).
- Wire function tools: rechecked live on DSH master fcc0ad4 (2026-11-08). The `Symbol.for` `TOOL_RUNTIME_SCHEDULER` workaround is no longer needed; a function-tool turn reaches `requires_action`, accepts `tool_result`, and completes. Verdict `resolved` on master and on the pinned tag `dsh-v0.2.2-rc.1`, see `docs/changes/2026-11-08-tool-scheduler-recheck.md`. The smoke script's default model `deepseek/deepseek-v4.1-flash` is rejected by the DeepSeek API; the plugin passes model names through unchanged.
- Slash commands landed (backend): `GET /v1/agents/commands`, `POST /v1/agents/sessions/{id}/commands/{name}` (409 `session_busy` during a turn), and the `slash_command` item. Spec `docs/superpowers/specs/2026-11-10-slash-commands-design.md`; write-up `docs/changes/2026-11-10-slash-commands.md`.

- Agentry Sandbox integration (2026-11-24, plan `agentry-web/docs/superpowers/plans/2026-11-25-agentry-sandbox-integration.md`): `sandbox` environment provider (`src/sandbox/agentry-sandbox-provider.ts`), `@agentry/api/sandbox-runtime` (`src/sandbox/remote/`), per-sandbox presets `agentry-sbx-<id>` (`src/sandbox/presets.ts`), sandbox sessions' artifacts/uploads through the provider. Enabled by `sandbox.url`/`sandbox.key` (or `AGENTRY_SANDBOX_URL`/`AGENTRY_SANDBOX_KEY`). Live-checked on the dev stack. Live suite `tests/sandbox-remote.spec.ts` needs Docker and `pnpm images:build` in agentry-sandbox. `AGENTRY_DEBUG_ERRORS=1` (dev only) returns session-create causes and logs sandbox runtime failures to stderr.
- Agentry general agent (2026-11-23, uncommitted): identity preset, per-agent skills (library, private, four install paths), command allow-list, Composio grants/approvals, connect requests. Write-up `docs/changes/2026-11-23-agentry-general-agent.md`.

## Backlog (cross-repo, agreed 2026-11-09; each needs its own spec)

Mirrored in `~/code/agentry-web/AGENTS.md`.

1. **Skill catalog endpoint (done 2026-11-10: `GET /v1/agents/skills`; per-agent skills and installs done 2026-11-23)** for the frontend's `/` picker. `/name` invocation already works through `dsh-tool-skill` when the profile mounts it; skills load from `<workspace>/.agents/skills`, `$DSH_HOME/skills`, `~/.agents/skills`, a configured directory, and `skill-office`. Per-owner skills could later come from a custom skill provider (the registry accepts any provider).
2. **Attachment/image endpoint** so clients can display screenshots and other images from tool results (owner-scoped). Upload and content routes for user attachments landed 2026-11-10 (`/agents/files`, see `docs/changes/2026-11-10-attachments.md`); serving tool-result images is a further `FileSource` on the same route: DONE 2026-11-26 (`docs/changes/2026-11-26-tool-images.md`; the web tool-card thumbnails are the remaining part).
3. **Browser automation in the profile:** mount `browser-use-playwright-mcp` (or Chrome DevTools / Stagehand) in the Agentry profile when Task 8 resumes.
4. **Vision-capable model route** for sessions that need screenshot review; DSH withholds images from non-vision routes.
5. **Cowork endpoints** for the frontend's F3 artifacts panel: deliverables, per-turn workspace changes. Non-image uploads landed 2026-11-10 with the attachment routes. Done 2026-11-26: Office files render to PDF (`/renders/pdf/*path`, DSH `officeToPdf`, `docs/changes/2026-11-26-office-render.md`) and changed files per turn with diffs (`/changes`, `/turns/{id}/changes[/{index}]`; DSH recorder for local chats, a shadow git repository inside the sandbox for sandbox chats, `docs/changes/2026-11-26-turn-changes.md`). Remaining: changes survive a restart (memory only today), local chats outside a git repository list file-tool edits only (shell-made changes are missed; the sandbox recorder could also serve local chats), fonts in the Docker image (conversions report missing fonts such as Arial), the file-watch stream and the sandbox port preview.

## Working rules

- Follow DSH conventions wherever code touches DSH APIs: registrations through `ctx.effect()`, branded ids, explicit config fields instead of hardcoded tunables, loud failure on misconfiguration. Read `../deepseek-harness/AGENTS.md` and its `docs/architecture.md` before relying on a DSH seam.
- When a DSH capability is missing, propose a small upstream change; do not patch the DSH checkout in place.
- Development parallelism: one session per repository once the API contract (OpenAPI spec) is fixed; subagents within a session for research, review, and plan-task execution.

## Changelog is mandatory

Every behavior, API, docs-layout, or packaging change that lands on this repo **must** update:

1. **`CHANGELOG.md`** — dated section with short bullets.
2. **`docs/changes/YYYY-MM-DD-<slug>.md`** — durable write-up when the change needs more than a bullet (new capability, wire contract, limitation, or migration).
3. **`docs/README.md`** — add a row for each new `docs/changes/` note.

Do not ship a commit that changes product behavior or public docs without the changelog entry in the same commit (or the same PR). Pure typo/format-only fixes may skip a `docs/changes/` file but still get a one-line `CHANGELOG.md` note when the fix is user-visible.

Link the detailed note from the CHANGELOG section when one exists.
