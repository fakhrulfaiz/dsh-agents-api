# Per-user harness containers (sandbox) design

Status: 2026-11-10, draft for review. Not implemented. Since 2026-11-11 this is a complementary layer (isolating users from each other); the main sandbox direction is `2026-11-11-pluggable-sandbox-design.md` (provider plugins, sandboxes per session). Facts below were read from `docs/http-api.md`, `AGENTS.md`, `src/environment/*` and the DSH checkouts; nothing was run.

## Goal

Give each user an isolated place where their agents run files and commands, so one user's agent cannot read or change another's data. Users see it as their sandbox: a dedicated container, with its state and limits shown in the web app.

## Understanding

- Today every session's tools run in the single DSH Host process of one backend, confined to the session workspace by `dsh-sandbox-local` (Landlock inside Docker). One container serves everyone; owner scoping is application-level (`ownerId` on every record).
- Agentry's `EnvironmentProvider` has `local` (a directory under `<workspaces>/<owner>/<environment_id>/`) and a parked `codebox` client. A provider only creates, inspects and moves files; it does not run commands. `environment.type: sandbox` answers an error ("there is no sandbox").
- A per-session Docker or hosted sandbox needs the agent's file and shell tools to run inside it. DSH has no per-session provider seam: the SSH family replaces fs and subprocess for the whole profile (our decisions already forbid it), and the E2B providers were retired upstream ("retire remote execution providers"; only build leftovers remain, and they are not in the pin `dsh-v0.2.2-rc.1`).
- The existing multi-user decision is "one harness container per user behind a router" (`AGENTS.md`, decision 5). This spec designs that. Per-session sandboxes and hosted vendors need the DSH seam and are out of scope.

## Design

```
browser -> web BFF -> router (auth, owner -> container) -> harness container (one owner)
                                     |                            volumes: /data/dsh, /data/workspaces/<owner>
                                     +-> orchestrator (start, stop, limits) -> Docker
```

- **Router** (new small service, no model code): authenticates the caller (Keycloak token or dev key), resolves the owner id, finds or starts that owner's container, and proxies `/v1` (HTTP and SSE, preserving `Last-Event-ID`) to it with an internal token and the owner id. The web app only changes `AGENTRY_API_URL` to point at the router.
- **Harness container**: today's image (DSH + `@agentry/api`), configured with one fixed owner. Its authenticator accepts only the router's internal token for that owner and refuses any other owner. Landlock confinement as today.
- **Storage**: workspaces and DSH home are per-owner volumes. Postgres stays shared with owner-scoped rows, but each container gets its own Postgres role limited by row-level security to its owner, so a compromised container cannot read other owners' rows with its database credentials. This is a requirement, not an option; without it, container isolation is undermined.
- **Lifecycle**: start on first request (cold start about 6 seconds here), stop after an idle period (default 30 minutes with no running turn, no open stream and no pending schedule). Scheduled tasks live in the container's Host scheduler, so a stopped container would miss them: keep the container up while the owner has an active schedule, or have the router wake it at the next run time (open item).
- **Router surface for the web app**: `GET /v1/sandbox` (state: running, starting, stopped; image; CPU, memory and PID limits; last active) and `POST /v1/sandbox/restart`. Everything else passes through unchanged.
- **Dev and single-user mode** stay as they are: no router, one backend.

## Docker access (the security decision)

The orchestrator needs to create and stop containers. Giving a process the Docker socket is close to root on the host, so:

1. Only the orchestrator holds Docker access. No harness container, and nothing that runs model-driven code, ever sees a socket.
2. Reach Docker through a socket proxy that allows only create, start, stop, inspect and remove on containers carrying our label, with a fixed image and fixed options (users cannot choose image, mounts, privileged mode or networks).
3. Prefer rootless Docker or Podman for the orchestrator's user, on a VM dedicated to this workload; gVisor (`runsc`) as an optional runtime.

## Container hardening (requirements)

Non-root user; read-only root filesystem with writable volumes only; `--cap-drop ALL`, `no-new-privileges`; memory, CPU and PID limits; no host mounts other than the owner's volumes; one network per owner with no container-to-container traffic; egress denied to private ranges and the cloud metadata address, allowed to the LLM provider, Composio and other configured MCP hosts. LLM provider keys are injected per container from the orchestrator's secret store; connector keys stay in the web BFF and are never stored in the container.

## Phases

1. **Harden the single-owner image**: fixed owner, internal-token auth, non-root, read-only root, limits. Run it under docker compose locally.
2. **Router with a static owner-to-container map** (compose), including SSE passthrough tests.
3. **Dynamic start and stop** through the socket proxy; idle stop; the schedule rule above.
4. **Database roles and row-level security** per owner.
5. **Egress policy** and the sandbox status endpoints for the web app.

The web app's Environments page (list local workspaces and files, show sandbox state, restart) gets its own spec after phase 2.

## Testing

Router: owner A can never reach owner B's container; unauthenticated requests rejected; SSE reconnect with `Last-Event-ID` through the router. Container: runs as non-root, cannot write outside its volumes, rejects another owner's token. Database: a container's role cannot read another owner's rows.

## Out of scope

Per-session sandboxes and hosted vendors (Codebox, Daytona, E2B), which need a per-session fs and subprocess seam in DSH; the SSH executor family; GPUs; quotas and billing; multi-host scheduling.

## Open items to verify before a plan

- Landlock availability inside Docker on the target kernel (the WSL2 dev kernel and the VM).
- How to keep scheduled tasks firing with idle stop (keep-alive versus router wake-up).
- Whether the harness can run with a read-only root filesystem (DSH and the office runtime may write under `$HOME`).
- Postgres row-level security against the existing owner-scoped queries.
- Where the router and orchestrator live: a new package in this repo or a separate repo.
