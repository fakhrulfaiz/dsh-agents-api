# Session background jobs (2026-11-27)

Branch `feat/session-jobs` (API and web). Not yet checked against a live agent.

## What

The Agentry preset mounts DSH's `tool-jobs` (`job_list`, `job_output`, `job_kill`) over the process-wide job registry `ctx.jobs` (`@deepseek-ai/dsh-jobs-local`). A shell command the agent starts with `run_in_background`, a foreground command moved to the background by its timeout, and a workflow all run as jobs; a finished job wakes the agent. Until now the web app saw only the tool calls. These routes let it list the jobs, follow their output and stop one.

| Method | Path | Answer |
|---|---|---|
| `GET` | `/v1/agents/sessions/{id}/jobs` | `{object: "list", data: Job[]}`, oldest first, each with the newest 16 KiB of output |
| `GET` | `/v1/agents/sessions/{id}/jobs/{job_id}` | `Job` with the newest 64 KiB of output |
| `POST` | `/v1/agents/sessions/{id}/jobs/{job_id}/kill` | `{outcome: "cancellation_requested" \| "already_finished", job: Job}` (no `output`); body `{"reason"?: string}` |

`Job`:

```json
{
  "id": "bash-3f2a9c1e", "object": "agent.session.job", "session_id": "sess_…",
  "kind": "bash", "command": "npm run build", "status": "running",
  "detail": null, "exit_code": null, "started_at": 1764230000, "finished_at": null,
  "output": { "text": "…", "total_bytes": 48211, "truncated": true }
}
```

`status` is DSH's `running | stopping | completed | killed | failed`. `detail` is the live progress line while running and the terminal reason once settled (`exit code: 2`, `signal: SIGTERM; stopped by the user`). `exit_code` is parsed from a completed job's `exit code: N` detail (shell jobs; a nonzero exit is still `completed`, as DSH reports it), null otherwise.

Stream: the session's SSE stream gains two ephemeral events (no `id:`, never replayed), raised by a `ctx.jobs.events` subscription (`watchJobs` in `src/jobs.ts`, mounted with `ctx.inject(['jobs'])`):

- `agent.session.job.updated` `{session_id, job}` on registration, progress change, stopping and settlement (`job` without `output`).
- `agent.session.job.removed` `{session_id, job_id}` when a record leaves the list.

Output appends are not announced (they can be many per second); a client that shows output re-reads the job.

## Decisions

- **Observer reads only.** Output comes from `ctx.jobs.readAt` (absolute offsets), never the consuming `read`, so the agent's `job_output` still gets every byte it has not collected. Text is stdout, stderr and producer `log` chunks in arrival order, cut to the newest N bytes on a UTF-8 boundary; `truncated` says earlier bytes are missing (cut, or dropped by the registry's ring retention).
- **Bounds.** 16 KiB per job on the list (it is re-read on every reconnect), 64 KiB for one job. No paging or offsets: the web app follows the end of a live log, and the agent keeps the full stream (spill files) for itself.
- **Own jobs only.** `ctx.jobs.list(caller)` also returns unowned jobs, which every caller may see; the routes keep only jobs whose `owner` is this session, so nothing leaks between owners. A subagent's jobs belong to the subagent session and are not listed under the parent.
- **Foreground commands appear while they run.** DSH's shell tool registers every command as a job and removes the record when a foreground call finishes in time; there is no flag that tells foreground from background in `JobView`. They are real running processes (and stopping one ends the tool call as killed), so the routes show them, and the stream's `.removed` event takes them out of a client's list. The web app may choose to hide very short-lived ones.
- **Kill.** `ctx.jobs.kill(id, session, reason)` with the given reason (trimmed, at most 200 characters) or "stopped by the user". The reason joins the terminal detail. The agent learns of it through `tool-jobs`' normal completion notice (the kill is not the model's own, so the notice is not suppressed); an idle agent is woken by it under the default `wakeup` delivery, which is the same as any other job finishing. A job that already finished answers 200 `already_finished`, not 409, so a Stop that races the finish is not an error. Unknown, unowned or foreign jobs answer 404.
- **Timestamps in seconds,** like every other `*_at` on this API (DSH keeps milliseconds).
- **Stream events plus re-read, not polling the list.** The registry already announces lifecycle commits, so pushing them through `SessionRegistry.emitEphemeral` costs one listener. Clients re-read `/jobs` on open and on reconnect (events are live only, like subagent events) and poll one job's output only while it is shown and running.
- **Memory only.** Jobs live in the registry: after an API restart, or once the session's agent is disposed, the list is empty. DSH logs `job/registered` and `job/settled` in the Session log, so finished jobs (without output) could be rebuilt later.

## Not yet

- A live check with a real `run_in_background` command, in a local chat and a sandbox chat (sandbox jobs run in the sandbox over the SSH executor family but are registered in the same process-wide registry, so the same route should serve them).
- Jobs after a restart; subagents' jobs; a way to tell foreground from background commands.
