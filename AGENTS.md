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
4. **Sandbox.** The container is the outer boundary (gVisor `runsc` optional). Per-session confinement uses DSH's own `dsh-sandbox-local` (`workspace-write` on the session workspace; inside Docker expect Landlock, because `bwrap` usually lacks user namespaces). **Do not use the DSH SSH executor family**: it replaces fs/subprocess/sandbox for the whole profile with one host, does not reconnect, and breaks DSH web workspace views. **Codebox is parked**: keep its client behind an `EnvironmentProvider` interface, disabled. Per-session cloud sandboxes (Daytona/E2B) need a per-session provider seam in DSH upstream first.
5. **Users.** Single user now, built to grow. Every agent, session, environment, and workspace record carries `owner`. Workspaces live at `workspaces/<owner>/…`. Later multi-user isolation = one harness container per user behind a router.
6. **Auth and governance: Keycloak (OIDC).** Auth sits behind one `Authenticator` interface. The API validates Keycloak access tokens (JWKS); `owner` = token `sub`; the admin API requires an admin realm role. The frontend talks to the API **only through its own backend (BFF)**; browsers never hold API credentials.
7. **Database: PostgreSQL.** Postgres stores Agentry-owned records: owners, saved agents, environments and templates, the session index (owner, agent, status, timestamps), and admin metadata. Keycloak uses its own Postgres database. The DSH Session log stays in DSH storage and remains the source of truth for model-visible history; never duplicate model requests into Postgres. Schema changes use numbered, forward-only migrations. The current JSON-file `durable-store.ts` is a stopgap to replace.
8. **Admin sees full model requests.** `/admin/v1` exposes all sessions, user messages, and the full per-turn model request (system prompt, context, tools, history) reconstructed from the DSH Session log through `dsh-session-query` (reuse the reconstruction in experimental `dsh-session-inspector`), plus live configuration through `dsh-config-editor` / `dsh-settings`.
9. **Parallelism in the product = DSH subagents** (already exposed at `/agents/sessions/{id}/subagents…`). Parallel children need disjoint file scopes.
10. **Frontend (later, separate repo).** Claude.ai-like information architecture (sidebar history and projects, chat-first pane, artifacts panel, settings sections) built with the astryx design system (`@astryxdesign/core`, `@stylexjs/stylex`, `@astryxdesign/theme-neutral`, `@astryxdesign/cli`). Copy layout and interaction patterns, never Anthropic branding (name, logo, mark, licensed fonts, exact colors). The frontend also ports DSH web features (trace/session-log inspector, tool and trajectory cards, subagent/team views, deliverables and per-turn diffs, plan/todo/goal panels, jobs and schedules) into the astryx design system. DSH is MIT: keep DeepSeek's copyright notice in files with substantial copied code. Every ported feature reads data only through Agentry API endpoints (via the BFF), never through DSH's internal remote layer, so each one needs a matching API endpoint.

## Status (update when it changes)

- Design for sub-project 1 (API hardening + admin API) and sub-project 2 (combined profile + VM container) is in progress; the spec will live in `docs/superpowers/specs/`.
- Known gaps: sessions, items, and turns are memory-only (lost on restart); SSE has no replay; no approval channel for sandbox escalation or user questions over the API; session setting updates do not retarget the live agent; Codebox execution depends on a `dockerSandbox` service that no DSH package provides.
- Wire function tools: rechecked live on DSH master fcc0ad4 (2026-11-08). The `Symbol.for` `TOOL_RUNTIME_SCHEDULER` workaround is no longer needed; a function-tool turn reaches `requires_action`, accepts `tool_result`, and completes. Verdict `resolved` on master and on the pinned tag `dsh-v0.2.2-rc.1`, see `docs/changes/2026-11-08-tool-scheduler-recheck.md`. The smoke script's default model `deepseek/deepseek-v4.1-flash` is rejected by the DeepSeek API; the plugin passes model names through unchanged.

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
