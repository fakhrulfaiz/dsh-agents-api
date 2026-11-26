# Owner-scoped schedule tools in chats

## What changed

The model-facing schedule tools `schedule_create`, `schedule_list`, `schedule_view` and `schedule_edit` (DSH `@deepseek-ai/dsh-tool-schedule`, mounted by the `agentry` preset and the sandbox presets) acted on every task of the Host schedule service, which stores no owner. Any chat could list, read, pause, retarget or delete another user's tasks. Each session's agent now gets owner-scoped copies of the four tools (`src/mount-schedule-tools.ts`), registered on the agent scope in `AgentsGateway.buildAgentSetup`.

- **Shadowing, not patching DSH.** A tool registered in the agent's own scope shadows the same name inherited from the preset scope (DSH `ToolsService.view`), the technique the sandbox `load_workspace_dependencies` uses. DSH stays unchanged.
- **DSH's own definitions.** `scheduleToolDefinitions` runs the package's `apply` against a small context holding only an owner-scoped service and captures what it registers, so schemas, descriptions, errors (`subagent_session`, `invalid_rule`, ...) and results are exactly DSH's. The prompt section stays with the preset's copy.
- **Same ownership as the HTTP routes.** `ownedScheduleService` uses `ownerOf` from `src/schedules.ts`: the owner of the target session, else of the first involved session with an index row.
  - `schedule_list` reads the catalog, keeps the caller's tasks, then applies `active`, `limit` and `offset` (same bounds and `invalid_rule` error as the Host); `total` counts only the caller's tasks.
  - `schedule_view` and `schedule_edit` answer `{ id, code: "schedule_not_found" }` for another owner's task, exactly as for an unknown id; `schedule_edit` checks before any change.
  - `schedule_create` is unchanged: its target is `this_session` or a new session created from the calling session, so the task belongs to the caller.
- **Fail closed.** A task whose owner cannot be determined (no target or involved session in the index) is invisible and unchangeable to everyone in chats. If the pinned DSH stops registering one of the four tools, the session setup fails instead of leaving an unscoped tool in place.
- **`host_tools` still hides them.** A scope's own registrations are not masked by `tools.restrict`, so a copy is registered only for names the session's `host_tools` mask admits; a hidden name keeps the restricted (invisible) preset tool.
- **Optional peers.** The module loads with a dynamic import only when the Host has a schedule service; `@deepseek-ai/dsh-tool-schedule` joins the optional peer dependencies.

## Limits

- Subagents are refused by the tools themselves (`subagent_session`), as before.
- A delivery's history (`runs`) and manual `run` are not model tools; they stay on the owner-scoped HTTP routes.
- Not checked in a live chat yet (two owners on one Host, each asking their agent to list and change tasks).

## Verification

`tests/mount-schedule-tools.spec.ts`: two owners over `FakeSchedule`, each lists, views, edits and deletes only their own tasks; cross-owner and ownerless ids answer `schedule_not_found` with no mutating call; a created task is listed for its creator only; `host_tools` masks and a missing schedule service register no copy.
