# Changelog

All notable changes to `@deepseek-ai/dsh-experimental-agents-api` are recorded here.
Detailed write-ups live under [`docs/changes/`](docs/changes/).

## 2026-09-18 — Host tool catalog and restrict

- Add `GET /agents/tools` for the live Host profile catalog (`source: "host"`).
- Add DSH extension `host_tools: { allow?, deny? }` on agents and session overlays; apply via `tools.restrict()` at session create.
- Reject empty `host_tools: {}`; unknown names fail when restrict runs.
- Inject `tools` so `GET /agents/tools` can call `ctx.tools.schemas()` (missing inject threw; webserver answered empty HTTP 400).
- See [docs/changes/2026-09-18-host-tools-catalog.md](docs/changes/2026-09-18-host-tools-catalog.md).

## 2026-09-18 — Host tool scheduler Symbol docs

- Document the wire-function `prepare` failure when Host `@deepseek-ai/dsh-tools` loads both `src` and `lib` under a per-module `Symbol` scheduler key.
- Point maintainers at `Symbol.for('@deepseek-ai/dsh-tools.scheduler')` ownership in `dsh-tools`, and keep the client `tool_result` contract separate.
- See [docs/changes/2026-09-18-tool-scheduler-symbol.md](docs/changes/2026-09-18-tool-scheduler-symbol.md).

## 2026-09-18 — README install vs develop

- Document `dsh plugin add` as the default install path; keep local-checkout develop and rebuild steps separate.
- Clarify that Host `tsconfig` wiring is monorepo build-only, not required for profile install.

## 2026-09-18 — Monorepo Host integration

- Publish as `@deepseek-ai/dsh-experimental-agents-api` and register in `tsconfig.host.json`.
- Build through the repository Host aggregate instead of a package-local `tsdown` prepare.

## 2026-09-18 — Package README reshape

- Slim the package README to the DeepSeek Harness `package-bundle` form.
- Move HTTP route and wire detail to [`docs/http-api.md`](docs/http-api.md).
- Fix the local install path to `./packages/experimental/dsh-agents-api`.
- See [docs/changes/2026-09-18-readme-reshape.md](docs/changes/2026-09-18-readme-reshape.md).

## 2026-09-18 — Agent changelog rule

- Add `AGENTS.md` and `.cursor/rules/changelog.mdc` so every shipped change updates `CHANGELOG.md` and `docs/changes/`.
- See [docs/changes/2026-09-18-agent-changelog-rule.md](docs/changes/2026-09-18-agent-changelog-rule.md).

## 2026-09-18 — Mount wire function tools

- Mount `agent.tools` entries of `type: "function"` as scoped Host tools.
- Park Host `execute` until the client posts `agent.session.input.tool_result` (legacy `function_call_output` accepted).
- Emit `agent.session.requires_action` and populate `required_actions`.
- Reject MCP / web_search / deferred function tools at create time.
- See [docs/changes/2026-09-18-mount-function-tools.md](docs/changes/2026-09-18-mount-function-tools.md).
