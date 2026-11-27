# Changed files per turn (2026-11-26)

Three owner-scoped routes expose the files each top-level turn changed, with diffs, for the web panel's Changes card and diff tabs.

## Routes

- `GET /v1/agents/sessions/{id}/changes`: `{ object: 'list', data: [{ turn_id, total, added, deleted, outside }] }`, newest first, turns with a summary only.
- `GET /v1/agents/sessions/{id}/turns/{turn_id}/changes`: `{ object: 'agent.session.turn.changes', turn_id, available, total, added, deleted, outside, files: [{ index, path, display, added, deleted, binary?, oversized? }] }`. Unknown turn: 404. Nothing recorded (or lost): `available: false`.
- `GET /v1/agents/sessions/{id}/turns/{turn_id}/changes/{index}`: `{ object: 'agent.session.turn.change', kind: 'text' | 'binary' | 'oversized', path, display, before?, after?, hunks?: [{ old_start, old_lines, new_start, new_lines, lines }], coarse? }`. Closing the request cancels the read.

## Sources

- **Local chats:** DSH's `workspaceChanges` service (`@deepseek-ai/dsh-workspace-changes`, mounted by `dsh-web-app`). The route maps each `workspace/changes { turn }` event to `turn_<seq of turn/start>`; a later event for the same turn wins. DSH snapshots the working tree with git only when the workspace is inside a git repository; otherwise (the usual Agentry workspace folder) it lists file-tool edits only, so files written by shell commands are not listed. Service absent: `available: false` and an empty list, not 503.
- **Sandbox chats:** DSH's recorder runs git and reads files through the Host's `subprocess` and `fs`, so it never sees a sandbox (checked on paper, plan task 8: the host `/workspace` placeholder is empty and not a repository, and file-tool captures read the host path, absent on both sides). `src/history/sandbox-changes.ts` records them instead, inside the sandbox through envd (`exec` on the sandbox provider, 30 s, 8 MB output): a shadow repository `/tmp/agentry-changes/<session>.git` (bare, `node_modules/`, `__pycache__/`, `.venv/` excluded; the user's own `.git` is never touched) snapshots the workspace with `git add -A` + `write-tree` at `turn/start` and `turn/end`, `diff-tree -z --numstat` lists files (500 listed, all counted), `git diff -U3` serves one file (over 2 MB: `oversized`). Tools wait for the turn-start snapshot (`tools/pre-execute`), as DSH's recorder makes them do. A failure logs one line and the turn has no summary.

## Rules

- Memory only: summaries are lost when the API restarts (DSH keeps its summaries per live Session; the sandbox recorder keeps them in this process). Sandbox snapshots live in the sandbox's `/tmp`, so after Stop or Reset the list stays but diffs answer 404.
- Files outside the workspace (absolute paths) are counted in `outside` and never listed; their diffs answer 404.
- Subagent sessions are not recorded (DSH rule); a subagent's edits in the parent's workspace land in the parent turn's summary.

Code: `src/history/turn-changes.ts`, `src/history/changes-api.ts`, `src/history/sandbox-changes.ts`, `src/history/numstat.ts`, `src/sandbox/agentry-sandbox-provider.ts` (`exec`, `workspaceDir`), `src/gateway.ts`, `src/index.ts`.
