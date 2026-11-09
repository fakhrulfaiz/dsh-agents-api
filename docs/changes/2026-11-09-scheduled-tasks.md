# Scheduled tasks

## What changed

The API exposes the Host schedule service (`ctx.schedule`) as owner-scoped `/v1/agents/schedules` routes so the frontend can list, create, edit, pause, run, and delete tasks. Design and task plan: [scheduled tasks design](../superpowers/specs/2026-11-09-scheduled-tasks-design.md). Wire detail: [Scheduled tasks](../http-api.md#scheduled-tasks) and `openapi/agentry.yaml`.

- **Routes** (`src/schedules.ts`, class `ScheduleApi`): create, list, retrieve, update, delete, `pause`, `resume`, `run`, `runs`. The gateway mounts them before `/agents/:agent_id`.
- **Ownership is derived.** The Host stores no owner. `ownerOf` takes the first of the target session and the involved sessions that has an index row (`store.sessions.ownersOf`, one query). Every route reads the task with `view`, resolves the owner, and answers 404 `schedule_not_found` for another owner before any `create`, `edit`, or `run` call. List filters the whole catalog the same way. No table was added.
- **REST-created tasks get their own chat.** `createIdleSession` provisions a session (no turn); the task is stored with a `session` target and the session as the acting session. A rejected task calls `AgentsGateway.discardSession`, which shares its teardown with `DELETE /agents/sessions/{id}`.
- **Deliveries run on the Agentry agent.** `schedule/resolve-agent` resumes the session through `AgentsGateway.agentFor`, so a delivery into a non-live session works after a restart and reaches the SSE stream and status writes. Deleting a session deletes its tasks first.
- **Prompts show in the chat.** A schedule-sourced `user/message` projects as a user item with `source: "schedule"` and the prompt extracted from the reminder framing (batches joined by a blank line, unparseable framing shown whole); change notices produce no item.
- **Prompt guidance.** The `agentry:schedule` section tells the model to create chat tasks with `this_session` and to use the user's stated time zone. Its text is empty when `schedule_create` is not visible.

## Decisions and limits

- Timing passes through unchanged (Host tagged union, snake_case) on input and output; the client always sends the time zone.
- `revision` is the task's `updated_at` and maps to the Host `expectedUpdatedAt`. A task without `updatedAt` (legacy rows) reports `created_at` as its revision and cannot be updated with a revision.
- `source` (`api` or `chat`) from the design is not returned: it needs a per-row session lookup.
- The paging `after` id names the previous page's last task among the caller's tasks; an unknown `after` starts from the first task. The list reads the whole catalog per request.
- One chat per task, not per run. Per-run chats, completion notifications, and per-owner isolation of the model's schedule tools are not done.
- The schedule service is an optional peer: `ScheduleInputError` and `RemoteError` from it are recognised by name and code, not by `instanceof`.
- A task created in a chat by the model is owned through its chat. If the model uses a `new` / `new_once` target anyway, the task is owned through the chat (involved session) but its `session_id` is the first indexed involved session until the Host creates the target session, which has no index row.

## Verification

Unit tests use `tests/support/fake-schedule.ts`; the contract test validates every route's request and response against the spec. Live verification against a running profile (an `at` task across a restart, a chat-created task visible to its owner only, `run`) is still open.
