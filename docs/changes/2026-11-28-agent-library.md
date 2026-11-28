# Agent Library sources (2026-11-28)

The web app's Agents page has a **Library**: agents to pick from and add, never added automatically. Its built-in agents ship with the web app (adapted from ECC, MIT). This change adds the user's own sources: a label plus a GitHub folder or gist link, stored per owner.

## Routes (owner scoped, Agentry extension)

| Route | What it does |
|---|---|
| `GET /v1/agents/library/sources` | `{ object: 'list', data: LibrarySource[] }`, oldest first |
| `POST /v1/agents/library/sources` `{ label, url }` | Adds one. The link must be a GitHub folder (`…/tree/…`) or a gist on the import hosts (`agents.importHosts`); it is read once to check it. 400 `invalid_label` (empty, over 40 characters, or "Agentry", the built-in source's name), `import_host_not_allowed`, `import_unrecognized` (a single file or an unknown link shape); 409 `library_source_exists` (same label, any case) or `library_sources_limit` (10 per owner); 404 `import_not_found`; 502 `import_fetch_failed` |
| `DELETE /v1/agents/library/sources/{id}` | Removes it; agents added from it stay. 404 for another owner's id |
| `GET /v1/agents/library/sources/{id}/agents[?refresh=1]` | The source's agent files `{ name, description, url }` |

`LibrarySource` is `{ id: 'lsrc_…', object: 'library.source', label, url, created_at }`, stored in the new `library_sources` table (migration `0007-library-sources.sql`, same shape as `agents`).

## Listing

Listing reuses the agent import fetch (`src/agent-import/fetch.ts`): the same hosts, HTTPS only, redirects only onto allowed hosts, 256 KB per file, 10 s per call, at most 200 files per folder. A folder lists its `.md` files with a `name` in the front matter; a gist is one file. Results are cached in memory for 10 minutes per link (at most 200 links); `?refresh=1` reads again. Adding an agent from a source goes through `POST /v1/agents/import` with the file's `url`, so nothing in these routes saves an agent.

## Import parser: Agentry library hints

The Markdown import parser also reads optional front matter that the built-in library files carry, so a downloaded library file imports the same way: `title` (display name instead of the title-cased `name`), `subagents: true` (turns on multi-agent), `browser: true|false`, and `apps` (Composio toolkit slugs, each granted in full). Claude Code and ECC files are unaffected.
