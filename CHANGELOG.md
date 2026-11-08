# Changelog

All notable changes to `@agentry/api` are recorded here.
Detailed write-ups live under [`docs/changes/`](docs/changes/).

## 2026-11-08 — Standalone build

- Renamed the package to `@agentry/api` (was `@deepseek-ai/dsh-experimental-agents-api` / `@fakhrulfaiz/dsh-agents-api`).
- Standalone build against a pinned DSH tag: `dsh.pin`, `DSH_ROOT`, `pnpm check:dsh-pin`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Entry is the built `lib/index.js`; the tsx-only `src/entry.js` is removed.
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
