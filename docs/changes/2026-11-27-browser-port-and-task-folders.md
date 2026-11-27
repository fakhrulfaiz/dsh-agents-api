# Browser DevTools port allocation and task folders (2026-11-27)

## Browser DevTools ports

Each sandbox chat runs its own Chromium with `--remote-debugging-port=<port>`, and the live view connects to the same port. The port used to be `20000 + sha256(sessionId) % 20000`, so two chats on one sandbox could collide (one Browser tab showing the other chat's browser, or Chromium failing to bind).

`BrowserPortAllocator` (`src/mount-browser.ts`, process-wide instance `browserPorts`) now allocates per sandbox:

- `acquire(sandboxId, sessionId)` returns the session's held port, else the hash-derived port probed forward (wrapping inside 20000-39999) past ports other sessions on that sandbox hold. `browserMcpTool` calls it, so a remount of the same session gets the same port.
- `portOf(sandboxId, sessionId)` is what the live view uses; it falls back to the derived port when nothing is held (for example after an API restart).
- Release: `releaseSession` in the gateway's session teardown (`stopLiveAgent`, used by session delete), `releaseSandbox` when a sandbox is stopped or reset (`/environments/{id}/stop|reset`) and when an environment is destroyed.

State is in memory only. After an API restart the browsers are gone with it, and the next mount allocates again.

## Task folders

`AGENTS_API_GUIDANCE_TEXT` (`src/mount-instructions.ts`) gains a third line: put the files of a multi-file task in one task-named folder, unless the user names a place or an existing project structure applies, and mention the folder in the answer. The workspace stays shared across chats.
