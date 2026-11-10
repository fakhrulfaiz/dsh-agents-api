# Sandbox Phase 1: Hardened Single-Owner Harness Image Implementation Plan

> **Status 2026-11-11: set aside, not started.** The sandbox work moved to the pluggable provider design (`docs/superpowers/specs/2026-11-11-pluggable-sandbox-design.md`). This plan belongs to the complementary per-user container layer and stays valid for when that layer is picked up. The spike notes in Task 1 so far: the `agents` profile is a directory under `$DSH_HOME/profiles/agents` whose `package.json` lists the bundles and links `@agentry/api`; the web server needs a concrete bind address (`host`, for example from `hostname -i`), not a wildcard; the pinned checkout has no absolute symlinks and can be copied.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Docker image and compose setup that runs DSH plus `@agentry/api` for exactly one owner, as a non-root user with a read-only root filesystem and resource limits, verified by a script.

**Architecture:** The image bundles a built DSH checkout (the pin), this repo's `lib/`, the `agents` profile and its patch. Auth uses the existing `apiKeys` mode with one entry, so only the router's key works and the owner is fixed. `docker/harness/` holds the Dockerfile, entrypoint and run script; `scripts/verify-container.sh` asserts the hardening from `docker inspect` and `docker exec`. No new application auth code.

**Tech Stack:** Docker (Docker Desktop on this machine, 29.7.2), Node 24, Postgres 16, bash, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-per-user-sandbox-design.md` (phase 1 of five)

## Global Constraints

- Never mount the Docker socket into a harness container, and never run it privileged or as root.
- Required runtime flags: non-root `--user`, `--read-only` with `--tmpfs` for temp and only owner volumes writable, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory`, `--cpus`, `--pids-limit`.
- Secrets (the router key, database URL, LLM keys) come from an untracked env file or `-e`; none is baked into an image, committed, or printed in logs or test output.
- The dev key (`AGENTRY_DEV_KEY`) is not used in this image; `auth.mode` is `apiKeys` with exactly one entry.
- Nothing under `deepseek-harness/` or `dsh-pinned/` is edited; the pin stays `dsh-v0.2.2-rc.1`.
- Commits: author `fakhrulfaiz <fakhrulfaiz2003@gmail.com>`; no `Co-Authored-By` or AI attribution. This repo's working tree has another session's uncommitted changes: stage only your own files and hunks.
- Run `export DSH_ROOT=$HOME/code/dsh-pinned` before `pnpm typecheck` and `pnpm test`.

## Review Focus

- A request with the wrong key, no key, or the right key claiming another owner is rejected; the right key acts only as the configured owner.
- The container cannot write outside its volumes and tmpfs, and the root filesystem is read-only.
- The container runs as non-root and has no Docker socket and no extra capabilities.
- The harness starts at all with a read-only root (DSH or the office runtime may write under `$HOME` and fail).
- Known gap carried to phase 4: the container still holds shared database credentials; the plan must say so in `docs/sandbox.md` and not claim database isolation.

---

### Task 1: Spike, then the image

**Files:**
- Create: `docker/harness/Dockerfile`, `docker/harness/entrypoint.sh`, `docker/harness/.dockerignore`, `docs/sandbox.md`

**Interfaces:**
- Produces: image tag `agentry-harness:dev` that, started with the env below, serves `GET /health` answering `{ ok: true, service: "agents-api" }` on port `3080`. Env contract: `AGENTRY_OWNER`, `AGENTRY_ROUTER_KEY_HASH` (`sha256:` plus 64 hex), `AGENTRY_DATABASE_URL`, `AGENTRY_WORKSPACES`, `AGENTRY_UPLOADS_DIR`, `DSH_HOME`, the LLM provider variables your profile already uses, and `HOME`.

- [ ] **Step 1: Spike (time-boxed to what it takes to answer, recorded in `docs/sandbox.md`):** find the minimal runtime layout that runs `pnpm dsh --profile agents --no-open` from a built DSH checkout in a container: which directories are copied (the pinned checkout is about 2 GB with `node_modules`), which command builds artifacts, what must exist at runtime (`lib/` of this repo, `cordis.patch.yml`, the office runtime if the office skills are wanted), and which paths DSH and the office runtime write to. Record each as a bullet list.
- [ ] **Step 2: Write the Dockerfile** from the spike (multi-stage; final stage runs as a numeric non-root user, `WORKDIR` on the checkout, `EXPOSE 3080`, `ENTRYPOINT` the script). The entrypoint creates the writable directories it needs under the mounted volumes, refuses to start when `AGENTRY_OWNER` or `AGENTRY_ROUTER_KEY_HASH` is empty, and execs the profile command.
- [ ] **Step 3: Build and start** `docker build -f docker/harness/Dockerfile -t agentry-harness:dev .` then run it with a Postgres reachable and the env above (plain flags first, hardening comes in Task 3). Expected: `curl -s http://127.0.0.1:3080/health` returns `{"ok":true,"service":"agents-api"}`.
- [ ] **Step 4: Commit** `feat(docker): harness image for one owner`.

### Task 2: One-owner auth config

**Files:**
- Modify: `cordis.patch.yml` (the `agents-api` entry's `auth`: use `apiKeys` with a single entry built from `AGENTRY_OWNER` and `AGENTRY_ROUTER_KEY_HASH` when the latter is set; otherwise the existing development `devKey` stays)
- Test: `tests/single-owner-auth.spec.ts`

**Interfaces:**
- Consumes: `Config`, `createAuthenticator`, `validateAuth` from `src/index.ts`; `ApiKeyEntry` shape `{ name, owner, hash, roles }`.

- [ ] **Step 1: Write the failing test** — build an `auth` block with `mode: 'apiKeys'` and one entry (`name: 'router'`, owner `owner_a`, a real `sha256:` hash of a test key, `roles: ['agentry-user']`); assert `validateAuth` accepts it; assert the authenticator returns the principal for `owner_a` with only `agentry-user` for the right key, and 401 for a wrong key, no key and a key with different case; assert an empty `apiKeys` list and a `devKey` alongside `apiKeys` are rejected by `validateAuth`.
- [ ] **Step 2: Run** `pnpm vitest run tests/single-owner-auth.spec.ts` — Expected: FAIL only if the test needs an unwritten helper; otherwise PASS, which confirms the existing mode covers the need (then keep the test as the pin).
- [ ] **Step 3: Update the patch** so the container profile selects `apiKeys` from env, keeping dev behavior unchanged when `AGENTRY_ROUTER_KEY_HASH` is unset (`tests/patch.spec.ts` must still pass).
- [ ] **Step 4: Run** `pnpm vitest run tests/single-owner-auth.spec.ts tests/patch.spec.ts` and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: single-owner auth profile for the container`.

### Task 3: Hardened run and the verification script

**Files:**
- Create: `docker/harness/run.sh`, `scripts/verify-container.sh`

**Interfaces:**
- Consumes: the image from Task 1.
- Produces: `docker/harness/run.sh NAME` starting a container with the Global Constraints flags (user `10001:10001`, `--read-only`, `--tmpfs /tmp`, volumes for `/data/dsh`, `/data/workspaces`, `/data/uploads` and `/data/home`, `--memory 4g --cpus 2 --pids-limit 512`, env from an untracked `docker/harness/.env`); and `scripts/verify-container.sh NAME` exiting non-zero on any failed check.

- [ ] **Step 1: Write `scripts/verify-container.sh`** with these checks, printing only pass or fail lines and never environment values: `docker inspect` shows a non-root `User`, `ReadonlyRootfs` true, `CapDrop` containing ALL, `no-new-privileges` in `SecurityOpt`, nonzero `Memory`, `NanoCpus` and `PidsLimit`, and no mount of `docker.sock`; `docker exec` shows `id -u` is not 0, `touch /x` fails, a write under `/data/workspaces` succeeds, and `/sys/kernel/security/lsm` is readable (record whether `landlock` is listed); `curl` with no key, a wrong key and a different owner header gets 401; `curl` with the right key gets 200 on `/v1/agents/skills`.
- [ ] **Step 2: Run it against a container started with plain flags** — Expected: FAIL on the hardening checks (proves the script detects them).
- [ ] **Step 3: Write `docker/harness/run.sh`** with the flags above; make `.env` the only source of secrets and add `docker/harness/.env` to `.gitignore`.
- [ ] **Step 4: Run** `docker/harness/run.sh harness-a && scripts/verify-container.sh harness-a` — Expected: every check passes. If the harness fails to start with a read-only root, find the failing write path from the logs and move it to a volume or tmpfs in the entrypoint (record it in `docs/sandbox.md`); do not drop `--read-only`.
- [ ] **Step 5: Commit** `feat(docker): hardened run and verification script`.

### Task 4: Compose for local use and the docs

**Files:**
- Create: `docker/compose.yml`
- Modify: `docs/sandbox.md`, `README.md` (a short "Run in a container" section), `CHANGELOG.md`, `AGENTS.md` (status line)

**Interfaces:**
- Produces: `docker compose -f docker/compose.yml up` starting Postgres and one harness container with the Task 3 hardening, plus named volumes.

- [ ] **Step 1: Write `docker/compose.yml`** mirroring `run.sh` (same flags expressed as compose keys: `user`, `read_only`, `tmpfs`, `cap_drop`, `security_opt`, `mem_limit`, `cpus`, `pids_limit`), a `postgres:16-alpine` service, a private network, and `env_file: docker/harness/.env`.
- [ ] **Step 2: Run** `docker compose -f docker/compose.yml up -d` then `scripts/verify-container.sh <harness container name>` — Expected: all checks pass.
- [ ] **Step 3: Write the docs:** `docs/sandbox.md` records the spike findings, the env contract, the flags and why, how to run and verify, the Landlock result from the verify script, and the known gaps (shared database credentials until phase 4; no egress policy until phase 5; no router yet). Add the changelog entry and the `AGENTS.md` status line; state that phases 2 to 5 of the spec are not started.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS (the Docker checks are a script, not part of `pnpm test`).
- [ ] **Step 5: Commit** `docs: run the harness in a container`.
