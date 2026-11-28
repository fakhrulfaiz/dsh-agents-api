# Agent import (2026-11-28)

Spec: `agentry-web/docs/superpowers/specs/2026-11-26-agents-import-and-owner-connectors-design.md` (part 2). Code: `src/agent-import/`.

`POST /agents/import` turns an agent definition into a draft for the web app's agent form. Nothing is saved; the user reviews the draft and saves it as a normal agent.

## Formats

- **Claude Code / ECC agent file**: front matter `name` (title-cased: `code-reviewer` → "Code reviewer"), `description` (kept in `metadata.description`), `tools` (comma list or YAML list), `model`; the Markdown body becomes `instructions` (over 65,536 bytes is refused).
  - Tools map to Host tools: `Read→read`, `Write→write`, `Edit|MultiEdit→edit`, `Grep→grep`, `Glob→glob`, `Bash→bash`, `WebFetch→web_fetch`, `WebSearch→web_search`, `TodoWrite→todo_write`, as `host_tools.allow`. `Task` turns on `multi_agent` instead. Names that do not map or that the Host catalog lacks are dropped and listed in `notes`. No `tools` line: no mask.
  - `model` (`opus`, `sonnet`, ...) is not mapped; `notes` says the user's default applies.
- **Agentry agent JSON** (`GET /agents/{id}`): known fields are kept when valid; `id`, timestamps and MCP tools whose credentials were masked (`***`) are dropped (noted).
- Anything else: 400 `import_unrecognized`.

## Links

`https` only, hosts from `agents.importHosts` (default GitHub and gists, the user's decision of 2026-11-28), so the server cannot be pointed at internal addresses. `github.com/<o>/<r>/blob/<ref>/<path>` is read from `raw.githubusercontent.com`; `/tree/` lists the folder through the GitHub contents API (`agent.import.candidates`, up to 200 files, read 8 at a time); gist links read `/raw`. Redirects are handled manually and followed only onto allowed hosts (at most 3). Bodies over 256 KB are refused; calls time out after 10 s. A file link's draft records `metadata.source_url`.
