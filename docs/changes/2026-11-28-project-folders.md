# Project folders (2026-11-28)

`OAISandboxEnvironment` and the stored `OAISandboxSessionEnvironment` gain `directory`: a path relative to the environment's workspace root. A session created with it starts in `<workspace>/<directory>` (the DSH session `cwd`).

- Validation: `normalizeWorkspaceSubdir` (`src/sandbox/workspace-subdir.ts`). Empty, `.` and `/` mean the workspace root. Refused: absolute paths, `..` segments, backslashes, control characters, more than 200 characters or 8 segments (400 `bad_request`).
- Creation: `Gateway.sandboxWorkspace` runs `mkdir -p -- '<cwd>'` as the agent user through the provider's `exec` (after starting a stopped sandbox); local environments use the host. Failure answers 409 `directory_unavailable` with the stderr tail.
- Projects: `project.environment.directory` is validated on create and update, and flows into new chats through `resolveProjectDefaults` unchanged.
- This is a starting folder, not isolation: the agent may leave it. Separation needs a separate environment.
- Resume after a restart reuses the cwd from the session log, so a resumed session keeps its folder (not covered by a dedicated test).

## Listing folders (follow-up)

`GET /agents/environments/{id}/folders?path=<relative folder>` answers `{ object: 'list', path, data: [{ name, path }], has_more }` with the folder's immediate sub-directories. `path` is checked with the same rules as `directory`. Sandbox providers run a small `sh` loop (no `find -printf`), starting a stopped sandbox first; the `local` provider reads the directory. Symlinks are skipped, a missing folder is 404.
