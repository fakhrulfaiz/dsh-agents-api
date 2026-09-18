# Docs

Package-local reference and change notes for `@deepseek-ai/dsh-experimental-agents-api`.

## Reference

| Page | Summary |
| --- | --- |
| [http-api.md](http-api.md) | Agents API routes, create/stream input, and function-tool wire contract |

## Changes

| Note | Summary |
| --- | --- |
| [2026-09-18-readme-reshape.md](changes/2026-09-18-readme-reshape.md) | Slim package README; move HTTP routes to http-api.md |
| [2026-09-18-mount-function-tools.md](changes/2026-09-18-mount-function-tools.md) | Mount wire `type: "function"` tools with parked Host execute and `tool_result` |
| [2026-09-18-host-tools-catalog.md](changes/2026-09-18-host-tools-catalog.md) | `GET /agents/tools` catalog and `host_tools` allow/deny → `tools.restrict()` |
| [2026-09-18-tool-scheduler-symbol.md](changes/2026-09-18-tool-scheduler-symbol.md) | Document Host `TOOL_RUNTIME_SCHEDULER` `Symbol.for` identity for wire function `prepare` failures |
| [2026-09-18-agent-changelog-rule.md](changes/2026-09-18-agent-changelog-rule.md) | Require CHANGELOG + docs/changes on every shipped change |
