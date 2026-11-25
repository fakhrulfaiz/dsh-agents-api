# Changelog

All notable changes to `@agentry/api` are recorded here.
Detailed write-ups live under [`docs/changes/`](docs/changes/).

## Unreleased

- 2026-11-25: CI builds the image against agentry-sandbox `develop` on pushes to `develop` (`SANDBOX_REF`), and `main` for pull requests.
- 2026-11-25: Agentry Sandbox places. `GET /agents/environments/providers` lists every place on the `sandbox` row (`places`: id, name, kind, default, available, reason, gpus, capabilities); the row is available when any place is, and `default_image` comes from the default place. `POST /agents/environments` accepts `place` (sandbox provider only, else 400); templates gain `place` and `gpus` (a count or `all`), and the sandbox provider's template fields include `gpus`. An environment's `sandbox` summary reports `place` and `gpus`.

## 0.1.1 — 2026-11-25

- Fixed: `GET /health` reported the API ready before its database was open, so health checks and Compose could send traffic during the seconds `/v1` still answered 503. It now answers 200 only once the store is open (503 `starting` / `failed` before), and the image's health check follows it.

## 2026-11-25 — readiness

- `GET /health` answers 200 only once the Postgres store is open (`/v1` can serve), and 503 `{ ok: false, store: "starting" | "failed", error? }` while it opens or after a failed start. It used to answer 200 at once, so container health checks, Compose and the web launcher could treat the API as ready during the seconds when every `/v1` call answered 503 `store_unavailable`. `AgentsGateway.storeStatus()` exposes the state.

## 0.1.0 — 2026-11-25

First tagged release of the Agentry API: the OpenAI Agents API–compatible surface on DeepSeek Harness (agents, sessions with streaming and replay, approvals, subagents, schedules, skills, files and deliverables, environments and templates on the local or Agentry Sandbox provider, sandbox tools for agents), now shipped as a Docker image (`ghcr.io/fakhrulfaiz/agentry-api`) with a compose file, as described in the entries below.

## 2026-11-25 — Docker image and CI

- The image ships DeepSeek Harness from npm (`@deepseek-ai/dsh@<dsh.pin version>`) and the plugin from its `npm pack` tarball with runtime dependencies only, instead of the built source tree: 1.49 GB instead of 3.22 GB. Verified the same as the full image: every entry activates, `/v1` and skills answer, and a turn runs up to the model call. `dsh.pin` must name a version published on npm.
- With the bundled Postgres the entrypoint builds the database URL from `POSTGRES_PASSWORD` (and `POSTGRES_HOST`, set by the compose file), so no connection string with a credential slot is written in the repository; `AGENTRY_DATABASE_URL` still wins when set.
- Example database URLs use `<user>:<password>@<host>` placeholders (a GitGuardian "generic password" alert on `user:password@host` was a false positive).
- `Dockerfile`: DeepSeek Harness at `dsh.pin` (cloned from the public repo, built with `build:artifacts`), the Office runtime (`prepare:primary-runtime`, `AGENTRY_OFFICE_RUNTIME`), Agentry Sandbox's client (cloned, `SANDBOX_REF`) and this plugin, in one image. `docker/entrypoint.sh` places the `agents` profile on the data volume (`DSH_HOME=/data/dsh`; image-owned files refreshed on every start, `cordis.patch.yml` kept), requires `AGENTRY_DATABASE_URL` and `AGENTRY_DEV_KEY`, and boots on the container's own address (DSH rejects wildcard binds). Workspaces and uploads live in `/data`. Verified: boots, every profile entry activates, `/v1` answers with the key and 401 without it, migrations run.
- `docker/compose.yaml` (the API plus Postgres 16) and `docker/agentry-api.env.example`; `docker/README.md` documents running and building.
- GitHub Actions: `ci.yml` builds the image on pushes to `develop` and pull requests to `main` (plus a "version not yet released" check on the pull request); `publish.yml` releases on merge to `main`: `ghcr.io/fakhrulfaiz/agentry-api` (`<version>-<sha>`, `<version>`, `latest`), tag `v<version>`, and a GitHub Release with the compose file (pinned) and the settings template (`scripts/ci/release-notes.sh` takes the notes from a `## <version>` section here).

## 2026-11-25 — Agentry Sandbox provider

- Sandbox tools for agents (registered on every session's agent when Agentry Sandbox is configured): `sandbox_list`, `sandbox_templates`, `sandbox_create`, `sandbox_start`, `sandbox_stop`, `sandbox_exec` (a shell command as `agent` in the sandbox's workspace; exit code plus the last 20 KB of stdout and 8 KB of stderr; 1–600 s) and `sandbox_delete`. Scoped to the session owner; creating and deleting ask the user first (`Create sandbox "…" (template or image, packages, no internet)`, `Delete sandbox "…" and all its files`); the sandbox the chat runs in is never stopped or deleted by them; Agentry Sandbox limits come back as the tool's error. `POST /agents/environments` and `sandbox_create` share one code path (`provisionEnvironment`).
- Fixed: template Python packages failed to install on the standard image (Debian 12's Python is externally managed); they are installed with `python3 -m pip install --user --break-system-packages`, falling back to plain `--user` for older pip. Fixed: an environment whose sandbox was never created (its create failed) could not be deleted; it now deletes, and the sandbox tools say it failed to set up and why.
- Fixed: in a sandbox chat, `load_workspace_dependencies` reported the server's bundled Office runtime (`~/.dsh/office-runtime/...`, paths that do not exist in the sandbox), so the agent was told it ran on the host. Sandbox sessions now get a sandbox version of the tool, registered in the sandbox preset's scope where it shadows the global one: it asks the container for its own Python, Node.js, pnpm and installed Python packages, and says `environment: "sandbox"`. `scripts/dev.sh` starts the API for development and reads every key from the git-ignored `.env` (`AGENTRY_DEV_KEY`, `AGENTRY_SANDBOX_URL`/`AGENTRY_SANDBOX_KEY`; the sandbox service's own secret and admin key live there too and are kept out of the API's environment).
- Templates take `resources: { cpus, memory_mb }` (cpus 0.1–64, memory_mb 128–262144), applied by the `sandbox` provider (it now lists `resources` in its template fields; `local` does not, so a `local` template with resources is reported unsupported). The `sandbox` provider row adds `default_image: { name, runtimes, python_packages, tools }` from Agentry Sandbox.
- For the web Sandboxes UI: `POST /agents/environments` takes an optional `name` (at most 80 characters; also the sandbox's name in Agentry Sandbox), and environments carry it. Agentry Sandbox environments carry `sandbox: { state, image, started_at, last_used_at }` (`state` is `running`, `stopped`, `provisioning`, `failed`, `deleting`, `gone` or `unknown`). Fixed: template files reached the sandbox only in a legacy form and were otherwise dropped; base64 `inline` files are now decoded, and `/workspace/...` paths land in the sandbox's workspace (`file_id` files are not applied yet).
- Small fixes (2026-11-24): sandbox environment status and provider availability answer within 10 s, and a sandbox service outage keeps an environment's last known status instead of reporting `failed` (a sandbox that no longer exists is still `failed`). Sandbox sessions list and read artifacts from the sandbox even when an S3 artifact store is configured; a sandbox artifact read answers 400 for a bad path, 413 over 100 MB and 503 when the sandbox is unreachable, instead of 500. A sandbox program stream stops reading once destroyed, aborts a Start that never began at once, and gives up signalling after 5 s. Deleting a session drops its cached deliverables.
- Review fixes: a session on a failed sandbox environment, or one provisioned while the service refuses, answers 409 `environment_failed` and never runs on the host; a sandbox that cannot start answers 503 `sandbox_unavailable` with the reason and is not left registered; a deleted sandbox reports that it no longer exists. Idle sandbox connections close their helper after 10 minutes (no calls, no open program streams), so sandboxes can idle-stop; the next call reconnects. The helper is closed gracefully (stdin closed, then SIGTERM, then SIGKILL). Skills are copied into the sandbox whenever its helper starts (after a stop, reset or idle close too), not only at first use.
- Sandbox sessions start in `danger-full-access` (a `sandbox/mode` event after create; the approval policy is unchanged), so `sudo` works inside the sandbox — DSH's permission seed would otherwise put them in `workspace-write`, whose in-container confinement sets `no_new_privs`. The sandbox connection starts a new helper on the next call after a transport loss (a stopped sandbox starts again; nothing in flight is replayed). The runtime plugin awaits each service so DSH's preset audit sees them. `AGENTRY_DEBUG_ERRORS=1` (development only) returns the cause of a failed session create and logs sandbox runtime failures to stderr.
- Workspace data of sandbox sessions comes from the sandbox: `GET /agents/sessions/{id}/artifacts` (path, size, modified time; `.git` and `node_modules` skipped; 503 `sandbox_unavailable` when the service is down), artifact reads, and attachment copies into `uploads/` (never overwriting, removed again on rollback). Deliverables read the session log and environment file routes already used the provider. Local sessions still use host disk.
- Sessions on an Agentry Sandbox environment run every tool inside the sandbox: they mount a per-sandbox preset `agentry-sbx-<sandboxId>` (the `agentry` rows from `cordis.patch.yml` inside one isolated group with `@agentry/api/sandbox-runtime`, `dsh-sandbox-policy`, `dsh-working-directory` and `dsh-bash-sandbox`). One registration serves every session on the sandbox, is released 5 minutes after the last session ends, and is removed at once when the environment is deleted. Subagents inherit it. The session's permission mode applies inside the sandbox (DSH's confinement is fully enforced there). Skills (the owner's and the built-ins) are copied into the sandbox at their identical paths, read-only for `agent`, when the preset is first registered. The service key never appears in preset rows.
- `@agentry/api/sandbox-runtime` (new package export, bundled as `lib/sandbox-runtime.js`): a Cordis plugin that makes an Agentry Sandbox its context's execution world by running DeepSeek Harness's own remote providers unchanged — `dsh-fs-ssh`, `dsh-subprocess-ssh`, `dsh-sandbox-ssh` and `dsh-ptc-runtime-node` — over `EnvdSshConnection`, a drop-in `ssh` service whose transport is the sandbox's envd (the DSH helper runs inside the sandbox from `/opt/agentry/dsh`; program streams are TLS-PSK authenticated end to end). Verified live against Docker: processes with exit codes and collected output, stdin, termination of the whole tree, terminals with resize, file read/write/edit/list/move/delete, 10 MB through streaming, DSH's size limits, `run_code` in the sandbox, and a clear error when the service is unreachable. The five SSH-family packages are optional peer dependencies.
- The `sandbox` environment provider (registered when `sandbox.url`/`sandbox.key` are set): environments live in Agentry Sandbox; each gets an empty host placeholder `<workspaces>/<owner>/sandbox-<envId>` and the sandbox mounts its workspace at that same path, so paths match on both sides. Files are read and written through envd as `agent`; quota refusals come back with the service's message. `POST /agents/environments` accepts `provider`; new `POST /agents/environments/{id}/start|stop|reset` (`keep_workspace`, default true; 409 `environment_not_startable` for `local`, 429 for a sandbox limit); `GET /agents/environments/providers` adds `available`, `reason` and `version` per provider. The service key never appears in responses.
- `sandbox.url` / `sandbox.key` (or `AGENTRY_SANDBOX_URL` / `AGENTRY_SANDBOX_KEY`) configure the Agentry Sandbox service; one without the other, or a non-http(s) URL, fails startup by name. `@agentry/sandbox` (linked, bundled into `lib/index.js`) provides the service client.

## 2026-11-25 — Item timing for the trajectory

- Saved items carry Agentry-extension timing from the Session log, in epoch milliseconds (`ItemTiming` in OpenAPI): assistant `message` and `reasoning` items get `step`, `timing.started_at_ms` (the step's `step/start`, else its first streamed token), `timing.first_token_at_ms` and `timing.completed_at_ms`, and the assistant message gets the step's `usage`; `function_call` and `command_execution` items get `step` and `timing.started_at_ms`, plus `completed_at_ms` once their result is logged; `function_call_output` and user messages get `timing.completed_at_ms`. Subagent items get the same. Fields are optional and additive; existing clients ignore them. Live and replayed projections stay identical, and wire frame ids do not change.

## 2026-11-24 — Skill viewer, agent avatars, faster deliverables

- `GET /agents/skills/view/{name}` lists a skill's files and `SKILL.md` (the caller's installed skills by name, else Agentry built-ins); `GET /agents/skills/view/{name}/files/{path}` returns one text file (≤ 256 KB; traversal 400, binary 415, larger 413), for the web skill viewer.
- `agent_create` / `agent_update` take an avatar `icon` and `color` (names in `src/agent-avatar.ts`, shared with the web app), saved as `metadata.icon` / `metadata.color`; the `create-agent` skill asks the model to pick ones that fit the agent's job.
- `GET /agents/sessions/{id}/deliverables` caches each session's list (with its workspace-relative paths) until the session's index row changes; a running session is always read. A repeat call drops from ~0.5–2 s (Session log read) to a few milliseconds, so the web Artifacts page no longer queues behind dozens of log reads.

## 2026-11-23 — Agentry as a general agent

Write-up: [docs/changes/2026-11-23-agentry-general-agent.md](docs/changes/2026-11-23-agentry-general-agent.md).

- Identity: sessions mount the new `agentry` agent preset (`preset-agentry` in `cordis.patch.yml`): DSH's web `standard` preset copied verbatim except the persona ("You are Agentry, a general-purpose AI agent …") and `skill-filesystem` `includeDefaultRoots: false`. The `system-prompt` row drops the "powered by DeepSeek Harness" opener (`includeHarnessIdentity: false`) and `harness-dev-context` is disabled. The skill and command catalogs read the Agentry preset's scope. A drift test fails when the pinned `standard` preset changes. DSH's own presets are untouched.
- Saved agents introduce themselves by name: `You are {name}, an agent built on Agentry.` (agent-scoped section `agents-api:identity`, order 9).
- `plugin_manager` is denied on every session (`ALWAYS_DENIED_HOST_TOOLS`); operators install plugins from the DSH GUI or `dsh plugin add`.
- Slash commands: `commands.allow` (default `goal`, `plan`, `compact`, `export`) filters `GET /agents/commands` and `POST /agents/sessions/{id}/commands/{name}` (others answer 404 `command_not_found`), so DSH's `/permission` and `/feedback` are hidden.
- Per-agent skills: every session registers an agent-scoped `agentry` skill provider serving exactly its agent's skills: built-ins from `skills/` (`create-agent`, and `composio`, moved from `.agents/skills`), the owner's library, and the agent's private skills. Saved agents gain `skills: { builtin, library } | null` (null or absent: every built-in; the default chat also gets the whole library). An agent update refreshes live sessions. Config: `skills.dir` (installed skills, default `~/.dsh/agentry-skills`), `skills.builtinDir`, `skills.workspaceSkills` (default false). The `skill-agentry` filesystem row is removed.
- Install skills: `POST /agents/skills` (multipart `.zip` → `pending_review`; JSON `name`/`description`/`body` → active editor skill), `GET /agents/skills/installed`, `GET /agents/skills/{id}` (review manifest: files, sizes, `SKILL.md`), `POST /agents/skills/{id}/activate`, `POST /agents/skills/{id}` (edit editor/chat skills), `DELETE /agents/skills/{id}`. Validation: one root `SKILL.md` with kebab-case `name` (≤ 64) and `description` (≤ 1024), ≤ 5 MB, ≤ 200 files, no symlinks, hidden or parent paths, zip-bomb ratio cap; errors `skill_invalid` (400), `skill_name_taken` (409), `skill_too_large` (413). Skills left in review over 24 h are swept hourly. `POST /agents/skills/import` (`repo`, `path`, `ref`) imports a public GitHub folder pinned to its commit, for review; `POST /agents/skills/{id}/update` re-imports it (changed content returns to review); GitHub failures answer 502 `skill_import_failed`. Files live under `skills.dir/<owner>/library|agents/<agent>/<name>`.
- Chat tools `skill_create` (name, description, body, scope) and `skill_install` (GitHub `repo`+`path`+`ref`, or an https `.zip` `url`) on every session. Each validates first, then asks for approval with the skill name, file count, script flag and description; approving installs it active with source `chat`. `scope: agent` targets the chat's saved agent.
- Composio grants: agents gain `apps` (app slug → `all` | tool slugs; legacy `metadata.connectors` reads as `all` per app; absent is unrestricted) and `send_policy` (`ask` default | `auto`). A `tools.guard` checks every `mcp__composio__*` call, each `COMPOSIO_MULTI_EXECUTE_TOOL` batch entry (a malformed batch is refused under a restriction) and `COMPOSIO_MANAGE_CONNECTIONS` toolkits; discovery meta tools stay allowed. Under `ask`, a call whose tool slug contains a write verb (`composio.approvalVerbs`, plus `composio.approvalSlugs`) asks first ("Send on your behalf?"). A guidance section (only while Composio tools are present) covers Connect buttons and 401/403 recovery. `agent_create`/`agent_update` write `apps` as grants clamped to the calling agent's own and accept a validated `skills` selection.
- `function_call_output` items gain `connect_request` (`toolkit`, `url`, `status`) when the output holds a Composio Connect Link.
- `GET /agents/skills` entries gain `kind` (`builtin` | `library` | `private` | `bundled`), `id` and `has_scripts` (installed skills), and `enabled`; developer sources (`user-*`, `project-*`) are hidden. Without `session_id` it lists the default chat's skills. New `skills` table (migration `0004-skills.sql`).

## 2026-11-11 — Pluggable sandbox providers, OpenAI Agents API shapes

- `GET /agents/environments/runtimes` (extension) reports the bundled Node, Python and pnpm versions and Python packages from the runtime payload's `runtime.json` (`AGENTRY_OFFICE_RUNTIME`).
- `SandboxProvider` contract and `SandboxRegistry`; the gateway names no concrete provider. `GET /agents/environments/providers` lists them with capabilities. See `docs/sandbox.md`.
- Environment templates, environments and environment files use the OpenAI Agents API shapes (`agent.environment.template`, `agent.environment`, `agent.environment.file`; token-paged file lists) with `provider`, `provider_metadata`, `image` and `unsupported_fields` as extensions. Breaking for clients of the earlier shapes: environment status values are `pending connected disconnected expired failed`, file paths are absolute `/workspace/...`, and the file list is a token page.
- A session `environment` of `openai_hosted` with `environment_template_id` or inline fields provisions through a provider; `sandbox` with `environment_id` attaches one. New errors: 400 `sandbox_exec_unavailable`, `sandbox_template_unsupported`.
- Codebox is removed (`CodeboxRemovedError` at load for its settings).

## 2026-11-10 — Agent management tools and the create-agent skill

- Every session mounts five agent-scoped tools, each limited to the session owner: `agent_tools`, `agent_list`, `agent_get`, `agent_create`, `agent_update` (`src/mount-agent-tools.ts`, shared validation in `src/agent-service.ts`). Writes ask for user approval; the tools accept no wire tools, credentials or URLs; `tools_allow` must be tools the session can see and never `agent_*`; created or updated agents get `host_tools.deny` with `agent_create` and `agent_update`; at most 100 saved agents per owner. `agent_tools` also groups the `mcp__<server>__<tool>` names into `mcp_servers`. The tools are mounted before the agent's `host_tools` mask, so an agent can hide them.
- New skill `skills/create-agent/SKILL.md`: a guided interview that asks with `ask_user_question`, surveys tools and MCP servers (Composio status with action `list` only), asks which connected apps to include, suggests apps to connect, shows a draft and saves only after a yes. Mounted by a second `@deepseek-ai/dsh-skill-filesystem` provider named `agentry` in `cordis.patch.yml` (`AGENTRY_SKILLS_DIR` overrides the directory, default `~/code/dsh-agents-api/skills`). Spec and plan: `docs/superpowers/specs/2026-11-10-agent-management-tools-design.md`, `docs/superpowers/plans/2026-11-10-agent-management-tools.md`. Live verification is open (see the plan's Task 5).

## 2026-11-10 — Redact MCP secrets in responses

- MCP `headers` values (`http` transport) and `env` values (`stdio` transport) in `agent.tools` are returned as `***` by every session and saved-agent response and every SSE event (create, get, list, update, `agent.session.*` snapshots, replay). Names, `command`, and `args` are unchanged. Stored records keep the real values, so restart recovery still mounts the tool with them. `POST /v1/agents/{id}` rejects `tools` containing `***` (400 `bad_request`). Details: [`docs/changes/2026-11-10-redact-mcp-secrets.md`](docs/changes/2026-11-10-redact-mcp-secrets.md).

## 2026-11-10 — Composio connectors (phase 0)

- `cordis.patch.yml` mounts Composio Connect as a profile-wide MCP server (`@deepseek-ai/dsh-mcp-client`, `serverName: composio`, tools `mcp__composio__*`). The consumer key is read from `COMPOSIO_API_KEY` in the harness environment (a gitignored `.env`), never stored in agent records or session config; `failOnStartupError: false` keeps Agentry booting if Composio is unreachable. Single-user only: every session shares one Composio identity. Per-owner keys and a Connectors page in the web app follow (`agentry-web` spec `2026-11-10-composio-connected-apps-design.md`).

## 2026-11-10 — Bundled office runtime

- `cordis.patch.yml` mounts `@deepseek-ai/dsh-tool-workspace-dependencies` from a prebuilt payload (`AGENTRY_OFFICE_RUNTIME`, default `~/.dsh/office-runtime/primary-runtime`) and points `skill-office` at the sibling `office-skills`, so agents use the bundled Python instead of pip-installing libraries. Build it with `pnpm run prepare:primary-runtime --target linux-x64 --output ~/.dsh/office-runtime` in the DSH checkout.

## 2026-11-10 — Session deliverables

- `GET /v1/agents/sessions/{id}/deliverables` lists the files the agent declared with the DSH `present` tool (`path` made workspace-relative when inside the workspace, optional `description`, `turn_id`, `created_at`), read from the Session log and owner-scoped. `present` and its prompt guidance already come from the web-app bundle's presets, so `cordis.patch.yml` is unchanged. Use it instead of the artifact listing to show only delivered files; bytes still come from the artifacts content route.

## 2026-11-10 — Workspace and shell guidance

- Every agent session now gets a system-prompt rule: do not search the whole filesystem (`/`, `/mnt`, home-wide `find`), stay in the workspace, and use the matching office skill's own scripts for docx/pptx/xlsx. The shell executor already defaults to a 120s timeout (max 600s) in DSH, so no profile patch was needed.

## 2026-11-10 — File attachments (backend)

- `POST /v1/agents/files` (multipart upload, magic-byte sniffing, size and quota limits, traversal-safe names), `GET /v1/agents/files/{file_id}/content` (owner-checked, `nosniff`, sandbox CSP, rasters inline, everything else a download), `DELETE /v1/agents/files/{file_id}` (staged only).
- Messages on `POST /sessions` and `.../events` accept `input_image` / `input_file` parts with `file_id`. Each file is stored in the DSH attachment store, copied to `<workspace>/uploads/` without overwriting, and logged with a note; images reach the model as images only on routes that accept them. User message items carry the file parts, live and after a restart.
- Migration `0003-files.sql`; new `uploads` config block (off until `uploads.dir` is set); staged files expire after `uploads.stagedTtlMinutes`; `@deepseek-ai/dsh-attachment` is a new peer and `busboy` a new dependency. Write-up: [docs/changes/2026-11-10-attachments.md](docs/changes/2026-11-10-attachments.md).

## 2026-11-10 — Artifact download headers

- `GET /v1/agents/sessions/{id}/artifacts/{path}` now sends the `Content-Type` for the file extension (`application/octet-stream` for unknown ones, `; charset=utf-8` for text types), `Content-Disposition: inline; filename="..."` (`attachment` with `?download=1`), and `X-Content-Type-Options: nosniff`.

## 2026-11-10 — Slash commands

- `GET /v1/agents/commands?session_id=` lists Host commands (`name`, `description`, `input_hint`, `accepts_attachments`) for the `/` menu: the live agent's catalog, the default preset's catalog for a session that is not live (no resume), and an empty list without `session_id`. Cached per scope for `commands.cacheTtlSeconds` (default 60), dropped on `commands/change` and `agent-preset/selected`, strong `ETag` with `304`, `503 commands_unavailable` on a failed read. `@deepseek-ai/dsh-commands` is a new optional peer.
- `POST /v1/agents/sessions/{id}/commands/{name}` (`{ input? }`) runs a command outside any turn: `200` with `status` `success` or `error` plus the result `item`, `404 command_not_found`, `409 session_busy` while a turn or another command is running, `500 command_failed`. Closing the request aborts the command.
- `command/run` + `command/done` become one `slash_command` item (`turn_id: null` between turns) in items, history replay, and a new `agent.session.item.done` SSE event. Frame ids of sessions that already logged commands shift by one frame per command.
- Write-up: [docs/changes/2026-11-10-slash-commands.md](docs/changes/2026-11-10-slash-commands.md). Wire detail: [docs/http-api.md](docs/http-api.md#slash-commands). Spec: `docs/superpowers/specs/2026-11-10-slash-commands-design.md`.

## 2026-11-10 — ask_user_question stays untimed

- Checked live: with the shipped presets (`tool-ask-user` in blocking mode) a session that calls `ask_user_question` reaches `requires_action` with a `user_question` approval, so no bridge or profile change was needed. `tests/ask-user-mode.spec.ts` pins the default `mode: legacy`; a `mode: timed` row would bypass the bridge (`wait.timed` requests are delegated), so `timeout: -1` is not a fix for it.

## 2026-11-10 — Office skills in the profile

- `cordis.patch.yml` mounts `@deepseek-ai/dsh-skill-office` as a host-level row, so the seven Office skills (`office`, `office-docx`, `office-pptx`, `office-xlsx`, `office-render`, `office-recalculate`, `office-export-pdf`) appear in `GET /v1/agents/skills` and load by name through every preset's `tool-skill`.

## 2026-11-10 — Host tool catalog scope

- `GET /v1/agents/tools` leased the default preset scope through `standingKeyFor`, which the pinned DSH does not have, so the call fell back silently to the empty global registry. It now uses `agentPresets.acquireScope()` and releases the lease. `tests/host-tool-catalog.spec.ts` covers it.

## 2026-11-10 — Scheduled task hardening

- `DELETE /agents/sessions/{id}` stops the live agent before it deletes tasks, and deletes tasks that list the session in `involvedSessionIds` as well as those that target it. Pause, resume, and delete send the revision read for the ownership check as `expectedUpdatedAt` (409 `schedule_conflict` on a change). `schedule_cleanup_failed` and session-create 500s return generic messages and log the cause. Write-up: [docs/changes/2026-11-09-scheduled-tasks.md](docs/changes/2026-11-09-scheduled-tasks.md#hardening).

## 2026-11-10 — Skill catalog endpoint

- `GET /v1/agents/skills` lists skills (`name`, `description`, `source`) sorted by name from `ctx.skills.list({ scope, cwd })`, read at request time. Optional `?session_id=` (owned by the caller, else `404`) selects that session's live agent scope and workspace; without it the default preset scope and the owner's default workspace root apply, so preset and `~/.agents/skills` skills appear in the Agentry profile. Without the skill service it answers `200` with an empty list. Cached in memory per (scope, cwd) for `skills.cacheTtlSeconds` (default 60, `0` disables), concurrent misses share one call, strong `ETag` with `304` on `If-None-Match`, `503 skills_unavailable` on a failed load (not cached). Wire detail: [docs/http-api.md](docs/http-api.md#skill-catalog); `openapi/agentry.yaml` declares the operation. `@deepseek-ai/dsh-skill` is a new optional peer.

## 2026-11-10 — Scheduled tasks

Summary of the scheduled-task work below (routes, session resolution, history items, prompt guidance, `ownersOf`, `createIdleSession`). Write-up: [docs/changes/2026-11-09-scheduled-tasks.md](docs/changes/2026-11-09-scheduled-tasks.md). Wire detail: [docs/http-api.md](docs/http-api.md#scheduled-tasks).

- The `/v1/agents/schedules` contract is in `openapi/agentry.yaml` (9 operations; `ScheduleTiming` is a `oneOf` by `kind`) and the contract test validates every route.

## 2026-11-10 — Prompt guidance for chat-created scheduled tasks

- Sessions get an agent-scoped system-prompt section `agentry:schedule` (just after `tool:schedule`) that tells the model to create scheduled tasks with target `this_session` only and to use the time zone the user stated, asking when it is unknown. The text is empty at each assembly where `schedule_create` is not visible, including after `host_tools.deny: ["schedule_create"]`. `new` and `new_once` targets would create sessions the API cannot list or resume.

## 2026-11-10 — Scheduled prompts in the chat history

- A prompt a scheduled task delivers to a session now appears as a user message item with `source: "schedule"` (and `schedule_id` when one task delivered it) and `content` set to the task prompt instead of the Host framing. A reminder batch joins its prompts with a blank line; framing that cannot be parsed shows the full text. `[SCHEDULE CHANGE]` notices still produce no item. Live and replayed projections agree. `MessageItem` in `openapi/agentry.yaml` declares both fields.

## 2026-11-10 — Scheduled task routes

- New `/v1/agents/schedules` routes over the Host schedule service: create, list (`status`, `limit`, `after`), retrieve, update (`revision` guard), delete, pause, resume, run now, and `runs` (delivery history). Every route is owner scoped: a task belongs to the owner of its target session, else of the first involved session in the index, and another owner's task answers 404 `schedule_not_found` before any mutating call. A profile without the schedule service answers 501 `schedules_unavailable`.
- `POST /agents/schedules` creates a dedicated idle session for the task (or targets the caller's own `session_id`); a task the Host rejects deletes the session it created. New `AgentsGateway.discardSession(owner, id)` is the teardown `DELETE /agents/sessions/{id}` uses, without the HTTP layer.
- Host input errors answer 400 with the Host code; `schedule_conflict`, `schedule_execution_pending`, and `schedule_target_archived` answer 409. The routes are in `openapi/agentry.yaml`.

## 2026-11-10 — Scheduled deliveries resume Agentry sessions

- Scheduled-task deliveries (`schedule/resolve-agent`) to a session in the index resume it with its Agentry setup (instructions, function and MCP tools, host-tool mask) and register it for SSE and status writes; other session ids keep the Host resolver. A session without a stored setup fails the delivery with `session_not_resumable`. New `AgentsGateway.agentFor(sessionId)`.
- `DELETE /agents/sessions/{id}` first deletes the scheduled tasks that deliver to the session; when the schedule service cannot be read, it answers 500 `schedule_cleanup_failed` and keeps the session.
- Fix: concurrent lazy resumes of one session (events, settings, scheduled deliveries) share one `agents.resume`; before, a second caller during the log read started another.
- `@deepseek-ai/dsh-schedule` is an optional peer dependency; profiles without the schedule service still load. `GatewayOptions.schedule` is required (return `undefined` when absent).

## 2026-11-10 — Session provisioning without a request

- Internal: `AgentsGateway.createIdleSession(owner, params)` creates an idle session (agent resolution, workspace, agent, index row, no turn) through the same `provisionSession` path as `POST /agents/sessions`; a failed agent create undoes the registration and writes no row (`SessionCreateError`). Groundwork for scheduled tasks. No wire change.

## 2026-11-10 — Store: owners of many sessions

- Internal: `Store.sessions.ownersOf(ids)` returns the owner of each existing session id in one query (groundwork for scheduled tasks, see `docs/superpowers/specs/2026-11-09-scheduled-tasks-design.md`). No wire change.

## 2026-11-09 — OpenAPI contract

- Added `openapi/agentry.yaml` (OpenAPI 3.1) covering every `/v1` route and `/health` with request and response schemas derived from `src/types.ts`, the error envelope, bearer security, and the SSE stream (`text/event-stream`, deterministic `id:`, ephemeral frames, `Last-Event-ID`). Clients generate types with `openapi-typescript`.
- `AgentsGateway.routeTable()` lists the registered routes. `tests/openapi-drift.spec.ts` compares them with the spec; `tests/openapi-contract.spec.ts` validates recorded gateway responses, streamed events, and fixtures against the spec schemas (`ajv`). The admin API (`/admin/v1`) is not in the spec yet.
- See [docs/changes/2026-11-09-openapi-contract.md](docs/changes/2026-11-09-openapi-contract.md).

## 2026-11-09 — Approvals over the API, live model and effort

- Sandbox escalations, tool approvals, and `ask_user_question` calls become `approval` entries in `required_actions` (`kind` `sandbox_escalation`, `tool_approval`, or `user_question`; optional `tool_name`, `call_id`, `questions`). The session shows `requires_action` and answers with `agent.session.input.approval_response` (`approve`, `deny`, or `answer` with `payload`). Unknown, answered, or cancelled ids answer 404 `approval_not_found`; mismatched decisions answer 400.
- `agent.session.requires_action` and `agent.session.in_progress` for approvals are ephemeral events (no `id:`, not replayed). Cancel, session delete, the end of the turn, and a restart drop pending approvals.
- `POST /agents/sessions/{id}` now retargets the live agent for `agent.model` and `agent.reasoning.effort` (applies from the next model step). `agent.session.input.message` accepts optional `model` and `reasoning.effort`. An unsupported or non-live change answers 409 `session_setting_not_live` and stores nothing.
- Fix: `reasoning.effort` on session create is passed to the agent (it was stored but ignored); an unsupported effort answers 400.
- Limits: subagent approvals fail closed; timed questions are unsupported.
- Breaking: the profile must provide `llm`, `approval`, and `userQuestions`; peer dependencies `dsh-user-approval` and `dsh-user-questions` added. `GatewayOptions.approvals` is required.
- See [docs/changes/2026-11-09-approvals.md](docs/changes/2026-11-09-approvals.md).

## 2026-11-08 — History from the Session log, restart recovery, SSE replay

- Items, turns, and `GET .../events` replay are derived from the DSH Session log (`dsh-session-query`) instead of memory, so they survive restarts. Live and replay share one projector (`WireProjector`): turn ids are `turn_<log position>`, event ids are `evt_<session>_<n>`, and each frame's SSE `id:` is its position in the derived sequence. `Last-Event-ID` replays exactly the missed events, then continues live.
- Status snapshots on connect, the idle event of a streamed create without input, and dispatch `error` events are ephemeral: no `id:`, never replayed.
- Startup recovery: sessions that were `in_progress` or `requires_action` are resumed through `ctx.agents.resume`, or marked `interrupted` with `last_error`. A POST to a session that is not live resumes it lazily. The session status is written to the index wherever its wire event is produced, so `listResumable` is accurate.
- Migration `0002` adds `sessions.body jsonb`: the session's resolved agent, environment, metadata, and vault ids, needed to rebuild the agent on resume. Recovery is skipped (warning, rows untouched) when the agent factory is not registered yet. Rows created before it cannot be resumed (409 `session_not_resumable`; interrupted at startup).
- Cancel reports `agent.session.turn.cancelled` when the Host ends the turn. An open turn at a crash becomes `cancelled` with `error.code: "interrupted"`.
- Fixes: `GET /agents/sessions` is built from index rows only (`has_more` and `last_id` agree with `data`); `workspaces` is required by the gateway (no host-cwd fallback); `POST /agents/sessions/{id}` answers 404 when the session row is gone.
- Breaking: the profile must provide `sessionQuery` and `sessionPersistence`; peer dependencies `dsh-session-query` and `dsh-session-persistence` added.
- See [docs/changes/2026-11-08-durable-history.md](docs/changes/2026-11-08-durable-history.md).

## 2026-11-08 — apiKeys auth mode

- New `auth.mode: apiKeys` for simple self-hosting: named keys (`agk_` + 43 base64url characters) in `auth.apiKeys`, stored as `sha256:` hashes; with `auth.keycloak` also set, either credential works. `pnpm keys:create --name <n> --owner <o> [--admin]` prints a key once and its config entry.
- `production` rejects `apiKeys` entries and `devKey`; `development` rejects `apiKeys`.
- Breaking: `workspaces` is required (the OS temp-dir fallback and the `AGENTS_API_WORKSPACES` env var are removed); the bundled patch reads `AGENTRY_WORKSPACES`.
- Fix: `POST /agents/sessions/{id}` writes the session index before changing the live session, so a store failure answers 503 and leaves the session unchanged.
- See [docs/changes/2026-11-08-api-keys-mode.md](docs/changes/2026-11-08-api-keys-mode.md).

## 2026-11-08 — Postgres store

- Agents, environment templates, environments, and a session index live in Postgres (`Store`, `src/store/`); numbered forward-only migrations run at startup under an advisory lock. The JSON-file `durable-store.ts` is removed.
- Every `/v1` route is owner-scoped: another owner's record answers 404. `/v1` answers 503 `store_unavailable` while the store opens, after it failed to start (`StoreStartError` logged), and when a database call fails.
- Environment routes go through `EnvironmentProvider`; local environments live at `<workspaces>/<owner>/<environment_id>/` and default session workspaces at `<workspaces>/<owner>/<session_id>/`.
- Breaking: `database.url` is required (`AGENTRY_DATABASE_URL` in the bundled patch); `dataDir` and Codebox settings are rejected at load (`CodeboxDisabledError`). `GET /agents/sessions` is newest first and ignores `order`.
- See [docs/changes/2026-11-08-postgres-store.md](docs/changes/2026-11-08-postgres-store.md).

## 2026-11-08 — Keycloak authentication

- Replaced the single `apiKey` with an `auth` block: `production` verifies Keycloak JWTs (issuer, audience, JWKS), `development` accepts a fixed `devKey`. Owner is the token `sub`; roles come from `realm_access.roles`.
- 401 responses carry code `unauthenticated` and `WWW-Authenticate: Bearer`; 403 uses `forbidden`. The gateway passes the `Principal` to every route handler; owner filtering follows with the store.
- Breaking: `apiKey` is removed; `cordis.patch.yml` reads the development key from `AGENTRY_DEV_KEY`.
- See [docs/changes/2026-11-08-keycloak-auth.md](docs/changes/2026-11-08-keycloak-auth.md).

## 2026-11-08 — Standalone build

- Renamed the package to `@agentry/api` (was `@deepseek-ai/dsh-experimental-agents-api` / `@fakhrulfaiz/dsh-agents-api`).
- Standalone build against a pinned DSH tag: `dsh.pin`, `DSH_ROOT`, `pnpm check:dsh-pin`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Entry is the built `lib/index.js`; the tsx-only `src/entry.js` is removed.
- `typecheck`, `test`, and `build` run the pin check (also rejects tracked-file changes); `dsh:link` fails when DSH declarations are missing; DSH peer ranges are `>=0.2.2-rc.1`.
- Carried over the parked function-tools note: [docs/changes/2026-09-18-agents-api-parked-function-tools.md](docs/changes/2026-09-18-agents-api-parked-function-tools.md).

## 2026-09-18 — Agent changelog rule

- Add `AGENTS.md` and `.cursor/rules/changelog.mdc` so every shipped change updates `CHANGELOG.md` and `docs/changes/`.
- See [docs/changes/2026-09-18-agent-changelog-rule.md](docs/changes/2026-09-18-agent-changelog-rule.md).

## 2026-09-18 — Mount wire function tools

- Mount `agent.tools` entries of `type: "function"` as scoped Host tools.
- Park Host `execute` until the client posts `agent.session.input.tool_result` (legacy `function_call_output` accepted).
- Emit `agent.session.requires_action` and populate `required_actions`.
- Reject MCP / web_search / deferred function tools at create time.
- See [docs/changes/2026-09-18-mount-function-tools.md](docs/changes/2026-09-18-mount-function-tools.md).
