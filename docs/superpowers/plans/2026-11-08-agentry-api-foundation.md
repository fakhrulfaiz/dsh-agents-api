# Agentry API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `dsh-agents-api` into `@agentry/api`: an OpenAI Agents API–compatible DSH plugin with Keycloak auth, Postgres storage, restart-safe history, approvals, an admin API, and a one-container VM deployment.

**Architecture:** The plugin keeps its existing route table in `src/gateway.ts` and adds four seams behind interfaces: `Authenticator` (Keycloak / development key), `Store` (Postgres), `SessionHistory` (DSH Session log via `ctx.sessionQuery`), and `ApprovalBridge` (DSH interaction answerers). A second route table serves `/admin/v1`. Deployment is one `agentry` DSH profile in a Docker image, composed with Caddy, Keycloak, and Postgres.

**Tech Stack:** TypeScript (ESM, strict), Cordis/DSH plugin APIs, vitest, `pg`, `jose`, `@testcontainers/postgresql`, tsdown, Docker Compose, Caddy, Keycloak.

**Spec:** [docs/superpowers/specs/2026-11-08-agentry-api-foundation-design.md](../specs/2026-11-08-agentry-api-foundation-design.md). Decisions: [AGENTS.md](../../../AGENTS.md).

## Global Constraints

- DSH pin: `dsh-v0.2.2-rc.1`, recorded in `dsh.pin`. Development resolves DSH sources from `$DSH_ROOT` (required; no default, because `../deepseek-harness` is the live master checkout, not the pin). Create the pinned tree with `git -C ../deepseek-harness worktree add ../dsh-pinned dsh-v0.2.2-rc.1` and export `DSH_ROOT=../dsh-pinned`. Never edit files under `$DSH_ROOT`.
- DSH packages are `peerDependencies` only; never add them to `dependencies`.
- Package name `@agentry/api`; the Cordis plugin `name` stays `'agents-api'`; route prefixes `/v1`, `/admin/v1`, and `/health`.
- Every Agentry-owned row has `owner_id`; a non-admin read of another owner's record returns `404`.
- Secrets come only from environment variables: `DEEPSEEK_API_KEY`, `AGENTRY_DATABASE_URL`, `AGENTRY_KEYCLOAK_ISSUER`, `AGENTRY_KEYCLOAK_AUDIENCE`, `AGENTRY_DEV_KEY`.
- Realm roles: `agentry-user`, `agentry-admin`.
- New wire error codes: `unauthenticated` (401), `forbidden` (403), `session_setting_not_live` (409), `approval_not_found` (404), `store_unavailable` (503).
- Every task that changes behavior updates `CHANGELOG.md` (dated bullet). New capabilities or wire contracts also add `docs/changes/2026-11-08-<slug>.md` and a row in `docs/README.md` (AGENTS.md rule).
- `AgentService` and `SessionQueryService` in this plan stand for the types of `ctx.agents` and `ctx.sessionQuery`. Import the names that `dsh-agent` and `dsh-session-query` actually export; do not declare local copies.
- Work on branch `feat/agentry-foundation`. Commit steps run only after the user has approved committing on this branch.

## Review Focus

1. **Keycloak signing key rotated mid-session** — a token signed by a newly rotated key must verify after one JWKS refetch, not fail until restart (Task 3 test `refetches JWKS on unknown kid`).
2. **Two API instances, or a crashed migration** — concurrent startup must not apply a migration twice or half-apply it (Task 4 test `migrations are idempotent under concurrent start`).
3. **SSE reconnect with a `Last-Event-ID` from before a restart** — replay must come from the Session log, not an empty in-memory buffer (Task 5 test `replays across restart`).
4. **Answering an approval after the session was cancelled** — must return `404 approval_not_found` and never resume a dead interaction (Task 6 test `approval after cancel is not found`).
5. **Admin request for a step that ran before compaction** — the rebuilt request must reflect the history that step actually saw (Task 7 golden test uses a compacted session).

---

### Task 1: Live check of wire function tools on the new DSH master

Settles whether removing `TOOL_RUNTIME_SCHEDULER` upstream (the `Symbol.for` fix) still breaks parked function tools.

**Files:**
- Create: `docs/changes/2026-11-08-tool-scheduler-recheck.md`
- Modify: `docs/changes/2026-09-18-tool-scheduler-symbol.md` (status line), `AGENTS.md` (Status section)

**Interfaces:**
- Consumes: the existing `agents` profile in `~/.dsh/profiles/agents`; `../agents-api-client/function_tool_smoke.py`
- Produces: a recorded verdict, `resolved` or `still-broken (<error text>)`, that gates Task 2

- [ ] **Step 1: Point the existing profile at this repo**

Run: `cd ../deepseek-harness && pnpm dsh plugin --profile agents remove @fakhrulfaiz/dsh-agents-api; pnpm dsh plugin --profile agents add ../dsh-agents-api`
Expected: the profile `package.json` lists this repo as a `link:` dependency.

- [ ] **Step 2: Start the host**

Run (separate terminal): `cd ../deepseek-harness && pnpm dsh --profile agents`
Expected: the webserver logs a listening address on port 3080.

- [ ] **Step 3: Run the smoke**

Run: `cd ../agents-api-client && .venv/bin/python function_tool_smoke.py`
Expected: the run reaches `requires_action`, posts `tool_result`, and the turn completes. Failure signature: `Cannot read properties of undefined (reading 'prepare')`.

- [ ] **Step 4: Record the verdict**

Write `docs/changes/2026-11-08-tool-scheduler-recheck.md` with the verdict, the DSH commit (`git -C ../deepseek-harness rev-parse HEAD`), and the smoke output. Update the AGENTS.md Status bullet. If still broken, stop and report to the user before Task 2; the fix belongs upstream in `dsh-tools`.

- [ ] **Step 5: Commit**

```bash
git add docs/changes AGENTS.md
git commit -m "docs: record tool scheduler recheck on DSH master"
```

---

### Task 2: Standalone repository, rename, and DSH pin

**Files:**
- Create: `dsh.pin`, `scripts/check-dsh-pin.ts`, `scripts/link-dsh.ts`, `vitest.config.ts`, `tests/check-dsh-pin.spec.ts`, `CHANGELOG.md` (from `../deepseek-harness/packages/experimental/agents-api/CHANGELOG.md`), `docs/changes/2026-09-18-agents-api-parked-function-tools.md` (from `../deepseek-harness/.agents/notes/implemented/feature/2026-09-18-agents-api-parked-function-tools.md`)
- Modify: `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `cordis.patch.yml`, `src/index.ts` (module JSDoc), `tests/loader-composition.spec.ts` (package name), `../agents-api-client/README.md` (install commands)
- Delete: `src/entry.js`

**Interfaces:**
- Produces: the `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check:dsh-pin` scripts every later task uses; `DSH_ROOT` resolution.

- [ ] **Step 1: Write the failing pin-check tests** in `tests/check-dsh-pin.spec.ts`

```ts
it('fails when DSH_ROOT HEAD is not the pinned tag commit', async () => {
  const result = await checkDshPin({ dshRoot: await fixtureRepoAt('other-commit'), pin: 'v-test' })
  expect(result).toEqual({ ok: false, reason: expect.stringContaining('v-test') })
})
it('passes when DSH_ROOT HEAD equals the pinned tag commit', async () => {
  expect(await checkDshPin({ dshRoot: await fixtureRepoAt('v-test'), pin: 'v-test' })).toEqual({ ok: true })
})
```
`fixtureRepoAt(ref)` creates a temporary git repo with two commits, tags the first `v-test`, and checks out `ref` (`other-commit` = the second commit).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/check-dsh-pin.spec.ts`
Expected: FAIL (`checkDshPin` is not defined).

- [ ] **Step 3: Implement `checkDshPin(opts: { dshRoot: string; pin: string }): Promise<{ ok: true } | { ok: false; reason: string }>` in `scripts/check-dsh-pin.ts`**

Compare `git rev-parse HEAD` with `git rev-parse <pin>^{commit}` inside `dshRoot`. The CLI entry reads `dsh.pin` and `DSH_ROOT` and exits 1 on `ok: false`.

- [ ] **Step 4: Make the repo build outside the DSH tree**

- `scripts/link-dsh.ts` writes untracked `tsconfig.dsh.json` containing `{ "extends": "<absolute DSH_ROOT>/tsconfig.base.json" }`.
- `tsconfig.json` extends `./tsconfig.dsh.json`, drops `references`, and keeps `rootDir: src` and `outDir: lib/types`.
- `vitest.config.ts` uses `vite-tsconfig-paths` with `projects: ['./tsconfig.json']` and `test.include: ['tests/**/*.spec.ts']`.
- `package.json`: `name: "@agentry/api"`, `version: "0.1.0"`, `repository.url` pointing at this repo (no `directory`), `main` and `exports["."]` → `./lib/index.js` with types `./lib/types/index.d.ts`, the `./src/*` export removed. DSH `peerDependencies` use `>=0.0.1-0` ranges (cordis `^4.1.0`). `devDependencies`: `vitest`, `vite-tsconfig-paths`, `typescript`, `tsdown`, `tsx`. Scripts: `dsh:link`, `check:dsh-pin`, `typecheck` (`pnpm dsh:link && tsc --noEmit -p tsconfig.json`), `test` (`pnpm dsh:link && vitest run`), `build` (`tsdown`).
- `.gitignore`: add `tsconfig.dsh.json`.
- Rename every `@deepseek-ai/dsh-experimental-agents-api` and `@fakhrulfaiz/dsh-agents-api` occurrence to `@agentry/api` (README, `cordis.patch.yml`, tests, client README).

- [ ] **Step 5: Verify**

Run: `export DSH_ROOT=../dsh-pinned && pnpm check:dsh-pin && pnpm typecheck && pnpm test && pnpm build`
Expected: pin OK; typecheck reports 0 errors in `src/`; all 17 existing spec files plus `check-dsh-pin.spec.ts` pass; `lib/index.js` exists.

- [ ] **Step 6: Carry over history, then delete the stale copy**

Copy the two files listed under Create and add a `2026-11-08` CHANGELOG section ("Renamed to @agentry/api; standalone build against a pinned DSH tag"). Then **ask the user** before running `rm -rf ../deepseek-harness/packages/experimental/agents-api ../deepseek-harness/.agents/notes/implemented/feature/2026-09-18-agents-api-parked-function-tools*`. These files are untracked, so git cannot restore them.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build: standalone @agentry/api against a pinned DSH tag"
```

---

### Task 3: Authenticator (Keycloak + development key)

**Files:**
- Create: `src/auth/authenticator.ts`, `src/auth/keycloak.ts`, `src/auth/static-key.ts`, `tests/auth.spec.ts`
- Modify: `src/index.ts` (Config `auth` block; construct the authenticator), `src/gateway.ts:195-200` (replace the `apiKey` comparison), `src/errors.ts` (new codes), `tests/gateway.spec.ts` (construct the gateway with a test authenticator), `package.json` (`jose`)

**Interfaces:**
- Produces:
```ts
export type OwnerId = string & { readonly __brand: 'OwnerId' }
export type Role = 'agentry-user' | 'agentry-admin'
export interface Principal { owner: OwnerId; roles: ReadonlySet<Role> }
export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; code: 'unauthenticated' | 'forbidden'; message: string }
export interface Authenticator { authenticate(req: IncomingMessage): Promise<AuthResult> }
export function createKeycloakAuthenticator(cfg: { issuer: string; audience: string; jwksTtlSeconds: number }): Authenticator
export function createStaticKeyAuthenticator(cfg: { key: string; owner: string; admin: boolean }): Authenticator
export function requireRole(result: AuthResult, role: Role): AuthResult
```
- Config validated in `src/index.ts`: `auth: { mode: 'production' | 'development'; keycloak?: { issuer; audience; jwksTtlSeconds = 600 }; devKey?: { key; owner; admin = true } }`. `production` together with `devKey` fails at load with a named error.
- `AgentsGateway` constructor takes `authenticator: Authenticator` in place of `apiKey: string`; route handlers receive the `Principal`.

- [ ] **Step 1: Write the failing tests** in `tests/auth.spec.ts`, using a local `jose` key pair served by a small `node:http` JWKS endpoint:
  - `accepts a valid token` → `principal.owner === sub`, roles from `realm_access.roles`
  - `rejects expired token` → `{ ok: false, status: 401, code: 'unauthenticated' }`
  - `rejects wrong issuer`, `rejects wrong audience` → 401
  - `refetches JWKS on unknown kid` → after rotating the key on the JWKS server, a token signed by the new key verifies
  - `requireRole forbids missing admin role` → 403 `forbidden`
  - `static key maps to configured owner`
  - `production mode rejects devKey config` → `Config({ auth: { mode: 'production', devKey: … } })` throws

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/auth.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the three auth modules and the gateway change**

Keycloak uses `jose.createRemoteJWKSet(new URL(issuer + '/protocol/openid-connect/certs'))` and `jwtVerify(token, jwks, { issuer, audience })`.

- [ ] **Step 4: Run the suite**

Run: `pnpm test`
Expected: PASS, including the updated `gateway.spec.ts`.

- [ ] **Step 5: Docs and commit**

Add a CHANGELOG bullet and `docs/changes/2026-11-08-keycloak-auth.md`.
```bash
git add -A && git commit -m "feat(auth): Keycloak and development-key authenticators"
```

---

### Task 4: Postgres Store and migrations

**Files:**
- Create: `src/store/store.ts`, `src/store/postgres.ts`, `src/store/migrate.ts`, `src/store/migrations/0001-initial.sql`, `src/environment/provider.ts`, `src/environment/local.ts`, `src/environment/codebox.ts`, `tests/store.spec.ts`, `tests/environment.spec.ts`, `tests/support/postgres.ts`, `tests/support/memory-store.ts`
- Modify: `src/index.ts` (Config `database: { url }`; run `migrate` at startup; Config rejects `codebox`; `artifacts` S3 block stays optional and absent by default), `src/gateway.ts` (agents, templates, environments, and the sessions index go through `Store`; environment routes go through `EnvironmentProvider`), `src/runtime-config.ts` (drop `dataDir`), `package.json` (`pg`, `@types/pg`, `@testcontainers/postgresql`)
- Delete: `src/agent-store.ts`, `src/durable-store.ts`, `src/environment-service.ts` (logic moves to `src/environment/`), `src/codebox-client.ts` (moves to `src/environment/codebox.ts`), `tests/agent-store.spec.ts` (move its pagination cases into `tests/store.spec.ts`)

**Interfaces:**
- Consumes: `OwnerId` (Task 3)
- Produces:
```ts
export interface SessionIndexRow {
  id: string; ownerId: OwnerId; agentId: string | null; environmentId: string | null
  dshSessionId: string; status: SessionStatus | 'interrupted'; lastError: string | null
  model: string; reasoningEffort: string | null; createdAt: Date; updatedAt: Date
}
export interface OwnedCollection<T extends { id: string }> {
  create(owner: OwnerId, value: T): Promise<T>
  get(owner: OwnerId, id: string): Promise<T | undefined>
  update(owner: OwnerId, id: string, value: T): Promise<T | undefined>
  delete(owner: OwnerId, id: string): Promise<boolean>
  list(owner: OwnerId, q: ListQuery): Promise<OAIListResponse<T>>
}
export interface SessionListQuery { owner: OwnerId | 'any'; agentId?: string; status?: string; from?: Date; to?: Date; cursor?: string; limit: number }
export interface Store {
  ensureOwner(owner: OwnerId): Promise<void>
  agents: OwnedCollection<OAIAgent>
  templates: OwnedCollection<EnvironmentTemplate>
  environments: OwnedCollection<EnvironmentRecord>
  sessions: {
    insert(row: SessionIndexRow): Promise<void>
    update(id: string, owner: OwnerId | 'any', patch: Partial<SessionIndexRow>): Promise<SessionIndexRow | undefined>
    get(id: string, owner: OwnerId | 'any'): Promise<SessionIndexRow | undefined>
    list(q: SessionListQuery): Promise<{ data: SessionIndexRow[]; nextCursor: string | null }>
    listResumable(): Promise<SessionIndexRow[]>
  }
  audit(entry: { actor: OwnerId; action: string; target: string }): Promise<void>
  close(): Promise<void>
}
export function openPostgresStore(url: string): Promise<Store>
export function migrate(url: string): Promise<{ applied: string[] }>
```
```ts
export interface EnvironmentProvider {
  readonly kind: 'local' | 'codebox'
  create(owner: OwnerId, environmentId: string, input: CreateEnvironmentInput): Promise<{ status: EnvironmentStatus; workspacePath: string }>
  status(record: EnvironmentRecord): Promise<EnvironmentStatus>
  destroy(record: EnvironmentRecord): Promise<void>
  listFiles(record: EnvironmentRecord): Promise<string[]>
  readFile(record: EnvironmentRecord, path: string): Promise<Uint8Array>
  writeFile(record: EnvironmentRecord, path: string, content: Uint8Array): Promise<void>
}
export function createLocalProvider(workspacesRoot: string): EnvironmentProvider
```
- The local provider places each environment at `<workspacesRoot>/<owner>/<environmentId>/` and rejects any file path that escapes it (reuse `sanitizeRelativePath` from `src/artifacts.ts`). `src/environment/codebox.ts` keeps the existing client behind the interface; no config path constructs it in this plan.
- Tables and indexes exactly as spec section 5.1. `migrate` holds `pg_advisory_xact_lock(hashtext('agentry-migrations'))` and records applied files in `schema_migrations(name text primary key, applied_at timestamptz not null)`. The cursor is base64 of `created_at|id`.

- [ ] **Step 1: Write the failing tests** (`tests/support/postgres.ts` starts one `PostgreSqlContainer('postgres:16-alpine')` per file):
  - `migrations apply from empty` → `applied` equals `['0001-initial.sql']`; a second call returns `[]`
  - `migrations are idempotent under concurrent start` → two `migrate()` calls in `Promise.all` apply each file exactly once
  - `owner scoping` → owner A's agent is `undefined` for owner B through `get`, absent from B's `list`, and B's `delete` returns `false`
  - `sessions.list filters` → by `agentId`, `status`, and `from`/`to`; newest first; cursor pages are disjoint
  - `listResumable returns in_progress and requires_action only`
  - `store outage returns 503` (in `tests/gateway.spec.ts`, memory fake whose methods reject) → `GET /v1/agents` answers `503` with code `store_unavailable`
  - `local provider isolates owners` (`tests/environment.spec.ts`) → environment `e1` for owner A lives at `<root>/A/e1/`; `readFile(record, '../B/x')` rejects
  - `codebox config is rejected` → `Config({ codebox: { … } })` throws a named error

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/store.spec.ts tests/environment.spec.ts`
Expected: FAIL (modules not found). Docker must be running.

- [ ] **Step 3: Implement** `0001-initial.sql`, `migrate.ts`, `postgres.ts`, the environment modules, and the in-memory `tests/support/memory-store.ts` fake of the `Store` interface. A rejected `Store` call inside a route handler answers `503 store_unavailable`.

- [ ] **Step 4: Wire `Store` into the gateway**, replacing every `AgentStore` and `FsAgentsApiStore` use. `gateway.spec.ts` uses the memory fake.

- [ ] **Step 5: Run the suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Docs and commit**

Add a CHANGELOG bullet and `docs/changes/2026-11-08-postgres-store.md`.
```bash
git add -A && git commit -m "feat(store): Postgres store with forward-only migrations"
```

---

### Task 4b: `apiKeys` auth mode for simple hosting

Implements spec section 5.7. Added 2026-11-08 at the user's request ("we want to have option for simple hosting").

**Files:**
- Create: `src/auth/api-keys.ts`, `scripts/keys-create.ts`, `tests/api-keys.spec.ts`, `docs/changes/2026-11-08-api-keys-mode.md`
- Modify: `src/index.ts` (Config: `auth.mode` gains `'apiKeys'`; `auth.apiKeys` array; validation; `ResolvedAuthConfig`; `createAuthenticator`), `package.json` (script `keys:create`), `README.md` (auth modes table + key creation), `docs/http-api.md`, `docs/README.md`, `CHANGELOG.md`, `AGENTS.md` (decision 6)

**Interfaces:**
- Consumes: `Authenticator`, `Principal`, `OwnerId`, `ownerId`, `Role`, `firstThen` (Task 3); the `ResolvedAuthConfig` pattern (no `?? default`)
- Produces:
```ts
export interface ApiKeyEntry { name: string; owner: string; roles: Role[]; hash: string } // hash = 'sha256:' + 64 lowercase hex
export function createApiKeyAuthenticator(entries: readonly ApiKeyEntry[]): Authenticator
export function hashApiKey(key: string): string            // 'sha256:<hex>'
export function generateApiKey(): string                   // 'agk_' + base64url(32 random bytes), 47 chars
```
- Mode `apiKeys` with `auth.keycloak` also set → `firstThen(apiKeys, keycloak)`. Mode `production` stays Keycloak-only: `production` with `apiKeys` entries fails at load. `devKey` remains rejected outside `development`.

- [ ] **Step 1: Write the failing tests** in `tests/api-keys.spec.ts`:
  - `generateApiKey format` → matches `/^agk_[A-Za-z0-9_-]{43}$/`; two calls differ
  - `hashApiKey format` → matches `/^sha256:[0-9a-f]{64}$/`; stable for the same key
  - `accepts a configured key` → principal owner and roles come from the entry
  - `rejects an unknown key, an empty bearer, and a missing header` → 401 `unauthenticated`
  - `apiKeys config validation` → an empty list, duplicate `name`, malformed `hash`, empty `roles`, or unknown role makes `Config(...)` throw a named error
  - `apiKeys mode with keycloak accepts either credential`
  - `production mode rejects apiKeys entries` → `Config(...)` throws
  - `keys:create prints a key and a matching entry` → run the script with `--name ci --owner ali`, parse the output, `hashApiKey(printedKey) === printedEntry.hash`, roles `['agentry-user']`; with `--admin` the roles include `agentry-admin`

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/api-keys.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `api-keys.ts` (hash the presented bearer once and compare it against every entry's digest with `timingSafeEqual`, without exiting early at the matching position), the Config changes, and `scripts/keys-create.ts` (prints the key once plus a YAML entry; writes no files).

- [ ] **Step 4: Run the suite**

Run: `export DSH_ROOT=/home/mffaiz/code/dsh-pinned && pnpm typecheck && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Docs and commit**

Add a CHANGELOG bullet and `docs/changes/2026-11-08-api-keys-mode.md`; document the three modes in README and in AGENTS.md decision 6.
```bash
git add -A && git commit -m "feat(auth): apiKeys mode for simple self-hosting"
```

---

### Task 5: History from the DSH Session log, restart recovery, SSE replay

**Files:**
- Create: `src/history/session-history.ts`, `src/recovery.ts`, `tests/session-history.spec.ts`, `tests/recovery.spec.ts`, `tests/support/fake-session-query.ts`
- Modify: `src/session-registry.ts` (keep live turn state and SSE fan-out; its `items`/`turns` arrays stop serving the list routes; seed the `emit` counter from history), `src/gateway.ts` (items, turns, and events routes read `SessionHistory`), `src/index.ts` (add `'sessionQuery'` to `inject`; run recovery after `migrate`)

**Interfaces:**
- Consumes: `Store.sessions` (Task 4); `ctx.sessionQuery.listEvents(id)` from `dsh-session-query`; the item mapping in `src/items.ts` and the event mapping in `src/bridge.ts`; `ctx.agents.resume()` from `dsh-agent`
- Produces:
```ts
export interface SessionHistory {
  items(dshSessionId: string, q: ListQuery): Promise<OAIListResponse<StoredSessionItem>>
  turns(dshSessionId: string, q: ListQuery): Promise<OAIListResponse<OAITurn>>
  turn(dshSessionId: string, turnId: string): Promise<OAITurn | undefined>
  wireEvents(dshSessionId: string, afterSeq: number): Promise<ReplayFrame[]>
}
export function createSessionHistory(sessionQuery: SessionQueryService): SessionHistory
export function recoverSessions(deps: { store: Store; agents: AgentService; history: SessionHistory }):
  Promise<{ resumed: string[]; interrupted: Array<{ id: string; reason: string }> }>
```
- `seq` is the 1-based index of a wire event in the sequence produced by folding the session's DSH events through `bridge.ts`. The live path (`SessionRegistry.emit`) assigns the same numbers: when a session is first registered or resumed, the registry seeds its counter with `(await history.wireEvents(id, 0)).length`.

- [ ] **Step 1: Write the failing tests**
  - `items match live projection` → feed a recorded event list to the fake `sessionQuery`; `history.items()` equals what the live bridge produced for the same events
  - `replays across restart` → emit 5 events live, rebuild registry and history from the same log, then `GET …/events` with `Last-Event-ID: 2` yields seq 3–5 followed by live seq 6, with no duplicates
  - `recovery resumes resumable sessions` → fake `agents.resume` succeeds → status unchanged, id listed in `resumed`
  - `recovery marks unresumable sessions interrupted` → `resume` throws → row status `interrupted`, `lastError` equals the error message

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/session-history.spec.ts tests/recovery.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** history, recovery, and the registry/gateway changes. Status writes happen in the same function that emits the matching wire status event.

- [ ] **Step 4: Run the suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Docs and commit**

Add a CHANGELOG bullet and `docs/changes/2026-11-08-durable-history.md`.
```bash
git add -A && git commit -m "feat(history): Session-log history, restart recovery, SSE replay"
```

#### Task 5 mini-plan (planning pass, 2026-11-08)

Evidence is from the repo at 5b6f2a0 and the pinned DSH at `/home/mffaiz/code/dsh-pinned` (`packages/...`). Where this section conflicts with the Task 5 text above, this section wins.

**Answers**

1. **Read API.** Not `listEvents`: it returns body-free `SessionEventRecord { sessionId, seq, type, time, surface }` (`session-query/src/types.ts:61`). Use `ctx.sessionQuery.readSession(sessionId: SessionId): Promise<SessionLogSnapshot>` (`session-query/src/index.ts:184`), with `SessionLogSnapshot { session: SessionHeader; inheritedEventCount; events: SessionEvent[] }` (`types.ts:51`). It is live-preferred: a session live in this process is read from memory, otherwise from `sessionPersistence` (README "Corpus resolution"). Events are detached clones, contiguous from `seq` 0 (`SessionEvent.seq`, `time` in epoch ms). A persisted log whose last turn never ended is balanced in memory with `interruptedTurnClosers` (`cold-read.ts:51`); nothing is written. It throws `SessionQueryError` (`SESSION_QUERY_SESSION_NOT_FOUND`, ...). There is no pagination; the whole log is returned, so callers fold and cache. `inject: ['sessionQuery']` is satisfiable: `bundle/base/cordis.patch.yml:157` mounts `session-query-sqlite` with `openAt: never` (exact reads work, search is disabled), and `web-app/cordis.patch.yml:27` restates it. `session-persistence-jsonl` is mounted at `base/cordis.patch.yml:138`, so `sessionPersistence` (needed by `resume`) exists too. `SessionHeader` carries `createdAt` (ms), `cwd`, `parentSession`, `origin` (`session/src/types.ts:95`).

2. **Is the wire mapping a pure function of the event list? No.** Dependencies on ambient state: (a) turn ids are `turn_${randomUUID()}` (`session-registry.ts:237`); (b) `event_id` is random (`bridge.ts:16`); (c) turn/session timestamps use `Date.now()` (`session-registry.ts:238,611`); (d) `turn.cancelled` is emitted by the gateway on `input.cancel` (`gateway.ts:797-806`), and the later DSH `turn/end` then runs with no current turn, so it emits only `idle` (the `reason.kind === 'aborted'` case is never mapped); (e) `requires_action` is emitted by `PendingFunctionCalls.syncRequiredActions` (`pending-function-calls.ts:140`), not from the log; (f) `agent.session.created`/`idle` come from `createSession` (`gateway.ts:504-536`); (g) `error` events from failed dispatch (`gateway.ts:510,529`) and the status snapshot on connect (`gateway.ts:698-704`) call `registry.emit` and so consume a seq. `itemsFromEvent` is already pure given `(event, turnId)`; item ids use `event.seq`.
   **Proposal: one pure incremental projector used by both paths.** New `src/history/projector.ts`:
   ```ts
   export interface ProjectionBase { sessionId: string; createdAt: number /* s */; agent: OAIAgent; environment: OAIEnvironmentConfig
     metadata: Record<string,string>; vaultIds: string[]; functionToolNames: ReadonlySet<string> }
   export class WireProjector {            // state: nextSeq, turns[], items[], status, error, requiredActions, usage, lastActiveAt, currentTurnId
     constructor(base: ProjectionBase)       // constructor emits frame 1: agent.session.created
     apply(event: SessionEvent): WireStep   // WireStep = { frames: ReplayFrame[]; status?: { status: SessionStatus; error: string | null } }
     readonly frames: readonly ReplayFrame[] // all frames so far (fold only; live path discards)
   }
   export function foldSession(base: ProjectionBase, events: readonly SessionEvent[]): WireProjector
   export function foldWireEvents(base: ProjectionBase, events: readonly SessionEvent[]): ReplayFrame[]  // = foldSession(...).frames
   ```
   Rules, each deterministic from the log: `turn_id = turn_${startEvent.seq}`; `event_id = evt_${sessionId}_${seq}`; timestamps `Math.floor(event.time/1000)`; session `created_at` from the index row; `turn/end` reason maps `completed|max-tokens|blocked` to completed, `error` to failed (code/message from `reason.error`), `aborted` to cancelled (`turn.cancelled` now emitted here, not by the gateway), `interrupted` to cancelled with `error { code: 'interrupted', message: 'Turn interrupted by a server restart' }`; `tool/call` whose `name` is in `functionToolNames` adds a `required_action`, sets `requires_action`, and emits `agent.session.requires_action`; the matching `tool/result` removes it and, when none remain and a turn is open, sets `in_progress` with no wire event (matches today). Unknown event types yield no frames, so a newer DSH cannot shift seq (wire `seq` is the projector's own counter, independent of DSH `seq`).

3. **Live seq equals replay seq by construction.** `registry.emit` today numbers frames per session from 0 (`session-registry.ts:389-394`). Change: the registry holds one `WireProjector` per session; `bridgeSessionEvent` becomes `registry.apply(sessionId, event)`, which runs `projector.apply` and fans out `step.frames` using the frame's own `id`. Replay is the same class folded over `readSession().events`, so ids agree. The pitfalls in answer 2 are removed as follows:
   - `created`: projector frame 1, derived from the base (index row), not an event.
   - `requires_action`, `turn.cancelled`, `turn.failed`: derived from `tool/call` and `turn/end` as above. `PendingFunctionCalls` keeps only the parking/resolving role and stops emitting or syncing status (Task 6 reshapes it further).
   - `idle` after a no-input stream create, the `idle|in_progress|requires_action` snapshot on connect, and dispatch `error` events: **ephemeral**. New `registry.emitEphemeral(id, event)` fans out without a seq or replay buffer; `writeEvent` writes it without `id:`. They are not log facts, so persisting them would break decision 7; clients that reconnect re-derive the snapshot.
   - Restart/resume: DSH `resume` appends `interruptedTurnClosers(persisted)` to the log before publishing and seed events never fire `session/event` (`agent-loop/src/index.ts:803-812`; `session/src/index.ts:555`). `readSession` on a cold log yields exactly the same closers (same function, `time = last.time`). So recovery does `readSession` first, builds the projector with `foldSession`, registers it, then calls `resume`; later live events continue at `nextSeq`. Resume appends nothing the fold has not already seen.
   - Replay window: the 200-frame in-memory buffer (`REPLAY_LIMIT`, `replayAfter`) is removed; `GET .../events` with `Last-Event-ID` subscribes first, buffers live frames, folds history, writes frames with `id > lastId`, then flushes the buffer skipping `id <=` the last written id. No gap, no duplicate.
   - Known divergence, documented: `session` snapshots inside old frames show the current agent/metadata (config is not in the log), not the config at that time.

4. **Resume.** `ctx.agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>` (`agent/src/index.ts:435`), options `{ resumeSessionId: SessionId; agentOptions?; setup?: AgentSetup; signal?; parentAgent? }` (`index.ts:126`). It opens the session for write, repairs the log with the closers, publishes, runs `setup(agentCtx)` before the agent is announced (`agent-loop/src/index.ts:763-836`). It needs `ctx.sessionPersistence` (throws `cannot resume: session persistence is not configured` otherwise) and has no `meta`/`cwd` parameter: cwd comes from the stored header (`readSession().session.cwd`; pass it to `mountMcpTools`). The Agents API needs the resolved agent (instructions, `tools`, `host_tools`, model, effort) to rebuild `setup`, but the index row has only `agent_id`, `model`, `reasoning_effort`, and an inline or overlaid agent is not stored anywhere. **Decision: migration `0002-session-config.sql` adds `sessions.body jsonb not null default '{}'` holding `{ agent: OAIAgent, environment, metadata, vault_ids }`** (Agentry-owned configuration, not model requests; consistent with decision 7). Rows from before 0002 have `{}` and cannot be resumed: they are marked `interrupted` with `last_error: 'session predates stored configuration'`. Extract the `agents.create` argument builder from `createSession` (`gateway.ts:410-440`) into `buildAgentSetup(resolved, pending, cwd)` shared by create and resume.
   Parked function calls: the pending promises die with the process, but the closers already wrote a `tool/result` error (`ToolOutcomeUnknownError`, `repair.ts:170-176`) for each started call and a `turn/end { kind: 'interrupted' }`. The fold therefore shows a failed `function_call_output` and a cancelled turn, `required_actions` is empty, and a client `tool_result` for the old `call_id` answers the existing 400 `unknown_call_id`. No extra reporting code. The new session `status` after resume is the fold's status (`idle`).

5. **Status writes.** Today the gateway never updates `sessions.status` after the insert at `gateway.ts:448`. Rule: the status is written where the projector emits the frame, through one `StatusWriter` (per-session promise chain so writes cannot reorder; errors logged, never thrown into the DSH listener). `WireStep.status` carries `{ status, error }` and `registry.apply` returns it to `index.ts`, which calls `gateway.recordStatus(id, status, error)` -> `store.sessions.update(id, 'any', { status, lastError })`. Transitions: create insert `idle` (existing); `turn/start` -> `in_progress`; parked function `tool/call` -> `requires_action`; `turn/end` completed or cancelled -> `idle`; `turn/end` error -> `failed` (`lastError` = message); recovery failure -> `interrupted` (`lastError` = reason); delete removes the row. `cancel` needs no direct write (the DSH `turn/end` follows). `listResumable` is correct only because of these writes. No write precedes `turn/start`: a crash between `followup()` and `turn/start` leaves no turn in the log, so nothing is lost.
   Deferred review items: (a) `listSessions` (`gateway.ts:546-566`) maps rows through `sessionFromRow(row)` (new, in `src/session-resource.ts`: base from `row.body`, `status` from the row with `interrupted` shown as `failed` and `error = lastError`, `required_actions: []`, `usage: null` unless live) and drops the registry join, so `data.length`, `last_id`, and `has_more` agree. (b) `GatewayOptions.workspacesRoot: string` required; delete the `undefined` branch at `gateway.ts:780`, and the `?? process.cwd()` at `gateway.ts:1109,1124` (use the live workspace or `history.workspace(id)`, the header `cwd`). `apply` already passes it; `tests/coreagent-surface.spec.ts:98` and the `gateway.spec.ts` helper pass a tmp root. (c) `updateSession`: compute the new config with a pure `applySessionUpdate(config, params)` extracted from `registry.updateSession`; `store.sessions.update` returning `undefined` (row deleted concurrently) answers 404; an invalid model stays 400 before any write. Persist the patched `body` in the same update.

6. **Pagination.** Items: `paginate(allItems, { ...q, order: q.order ?? 'asc' })` on the folded `projector.items` in log order (same as `registry.listItems`, `session-registry.ts:344`). Turns: `paginate(turns, q)` over the fold's turns in log order **without** the `createdAt` sort argument: `registry.listTurns` sorts by second-resolution `created_at` (`:308`), and equal timestamps keep ascending order under `desc`, which is wrong for turns opened in the same second. `after` is an id lookup in the already-ordered list (`http.ts:185-188`), `has_more` is `list.length > limit`. `turn(id)` is a find in the fold. Subagent items never appear: child events are in child sessions, and the subagent routes stay on the in-memory registry (known gap, listed below).

7. **Test strategy.** `tests/support/fake-session-query.ts` exports `FakeSessionQuery implements Pick<SessionQueryEngine, 'readSession'>` (type-import from `@deepseek-ai/dsh-session-query`). It holds `live: Map<SessionId, SessionEvent[]>` and `cold: Map<SessionId, SessionEvent[]>`; `readSession` returns `{ session: header, inheritedEventCount: SessionLogOffset(0), events }` where cold reads append the real `interruptedTurnClosers(events)` from `@deepseek-ai/dsh-session`, and a missing id throws `SessionQueryError('SESSION_QUERY_SESSION_NOT_FOUND')`. Helpers `append(id, event)` mirror a live session and `crash(id)` moves live to cold. Fake `agents.resume` is `vi.fn<(o: ResumeAgentOptions) => Promise<AgentHandle>>()` returning `{ agent, dispose }`; assert `resumeSessionId` and that calling `options.setup(agentCtx)` mounts the function tools (reuse `fakeContext` from `gateway.spec.ts`). Real-composition: extend `tests/loader-composition.spec.ts` with real `dsh-session` + `dsh-session-persistence-jsonl` (tmp root) + `dsh-session-query-sqlite` (`path: ':memory:'`, `openAt: 'never'`) providing `sessionQuery` and `sessionPersistence`, and the existing fake `agents`: create a session, append wire-relevant events through the real `ctx.sessions` (`session.append`), `GET /items` and `/events` with `Last-Event-ID` through HTTP, then dispose and rebuild the context on the same tmp root and assert the same lists. If building the `ctx.sessions` fixture needs more than the `sessions` + persistence plugins (agent loop, llm), skip the restart half and keep the type-faithful fakes; say so in the PR.

**Final interfaces (changes from the Task 5 text)**

```ts
// src/history/session-history.ts
export interface SessionHistory {
  items(base: ProjectionBase, q: ListQuery): Promise<OAIListResponse<StoredSessionItem>>
  turns(base: ProjectionBase, q: ListQuery): Promise<OAIListResponse<OAITurn>>
  turn(base: ProjectionBase, turnId: string): Promise<OAITurn | undefined>
  wireEvents(base: ProjectionBase, afterSeq: number): Promise<ReplayFrame[]>
  fold(base: ProjectionBase): Promise<WireProjector>          // for recovery seeding and session payloads
  workspace(sessionId: string): Promise<string | undefined>   // header cwd
}
export function createSessionHistory(sessionQuery: Pick<SessionQueryEngine, 'readSession'>): SessionHistory
// recovery.ts
export function recoverSessions(deps: { store: Store; agents: Pick<AgentRegistry,'resume'>; history: SessionHistory
  adopt(row: SessionIndexRow, projector: WireProjector, handle: AgentHandle): void }): Promise<{ resumed: string[]; interrupted: Array<{ id: string; reason: string }> }>
```
Changes and reasons: `ProjectionBase` replaces the bare `dshSessionId` argument because the fold needs agent config and function tool names that are not in the log; `fold` and `adopt` exist so recovery can register the projector before `resume` (answer 3); the dependency is `Pick<SessionQueryEngine,'readSession'>`, not `listEvents`. `Store.SessionIndexRow` gains `body: SessionConfig`. `registry.emit` is replaced by `registry.apply(id, event)` plus `registry.emitEphemeral(id, event)`; `register` takes a seeded `WireProjector`. `inject` becomes `[..., 'sessionQuery', 'sessionPersistence']`; add both packages to `peerDependencies`. `recoverSessions` rethrows when `resume` fails with `no agent factory registered` or `cannot resume: session persistence is not configured` (startup misconfiguration fails loud and leaves rows untouched); any other rejection marks the row `interrupted`.

**Ordered steps**

1. Migration `0002-session-config.sql`, `SessionIndexRow.body`, `SessionConfig` type; update `postgres.ts`, `memory-store.ts`, `store.spec.ts` (both stores).
2. `projector.ts` + `foldWireEvents` with tests (below); reuse `itemsFromEvent` unchanged.
3. Registry holds projectors; `apply`, `emitEphemeral`; remove `items`/`turns`/`replay` buffer and `createTurn/openTurn/completeTurn/failTurn/cancelTurn`; `bridgeSessionEvent` delegates; adapt `session-registry.spec.ts`, `bridge.spec.ts`, `pending-function-calls.spec.ts`.
4. `session-history.ts`, with a fold cache keyed by `(sessionId, events.length)`.
5. Gateway: `buildAgentSetup`, store `body` on create, required `workspacesRoot`, `sessionFromRow`, list/get/update/items/turns/events/artifacts routes on the index row and history, `ensureLive(owner, id)` that lazily resumes an idle non-live session before `POST .../events`, `input.cancel` stops emitting `turn.cancelled`, `StatusWriter` via `recordStatus`.
6. `recovery.ts`; `index.ts` wiring: `inject`, history construction, `recoverSessions` after `attachStore` inside `openStore`, `StatusWriter`.
7. Docs: `CHANGELOG.md`, `docs/changes/2026-11-08-durable-history.md`, `docs/http-api.md` (SSE ids, ephemeral events, interrupted turn), AGENTS.md Status lines (items and turns no longer memory-only; SSE replay).

**Test list**

- `projector.spec.ts`: `fold equals incremental` (random valid logs: folded frames deep-equal frames from per-event `apply`, ids `1..n`); `ids are deterministic across folds`; `aborted turn/end emits turn.cancelled`; `interrupted turn/end -> cancelled with code interrupted and status idle`; `error turn/end -> failed and session status failed`; `function tool call emits requires_action and result clears it`; `unknown event types emit no frames`.
- `session-history.spec.ts`: `items match live projection` (feed events through `registry.apply`, compare to `history.items`); `turns desc order is stable within one second`; `after/limit/has_more match paginate`; `reads history for a session that is not live`; `workspace comes from the header cwd`.
- `recovery.spec.ts`: `resumes in_progress and requires_action rows` (`resumeSessionId` asserted, status unchanged, id in `resumed`); `registers a projector seeded with the closer events before resume` (registry `nextSeq` equals fold length); `marks unresumable rows interrupted with lastError`; `marks rows without stored config interrupted`; `rethrows when no agent factory is registered`; `resumed setup mounts function tools and a stale tool_result answers 400 unknown_call_id`.
- `gateway.spec.ts` additions: `replays across restart` (5 events, rebuild registry+history from the same log, `Last-Event-ID: 2` yields 3-5 then live 6, no duplicates); `replay with events arriving during the fold are deduplicated`; `listSessions after restart has consistent has_more and last_id`; `updateSession answers 404 when the row is gone`; `status is written on turn start, requires_action, completion, failure`; `error and snapshot events carry no id`; `workspacesRoot` is required (the `typecheck` run rejects an options object without it).
- `loader-composition.spec.ts`: `serves items and replay after the context is rebuilt` (see answer 7).

**Risks**

- `tool/call.callId` must equal `exec.callId` used by `PendingFunctionCalls`; assert in the projector test with a recorded log.
- A DSH `session/event` listener runs synchronously inside the loop: `StatusWriter` must never throw or await there.
- Folding on every list request is O(log size); the `(id, length)` cache bounds repeated cost, and a long-session benchmark is a follow-up, not Task 5.
- `agentLoop` may register the agent factory after this plugin starts; recovery fails loud (rows untouched) rather than marking sessions interrupted. Verify in the real-composition test whether `inject` ordering is enough; if not, add the loop's service name to `inject`.
- Rows created before 0002 are not resumable; acceptable because no deployment exists yet (pre-1.0).
- Subagent routes, `agent.session.created` snapshots, and `usage` on non-live list rows are still memory-derived; Task 5 does not make subagent history durable.
- `turn.cancelled` now arrives after the DSH `turn/end` instead of at request time (a few ms later); clients that relied on immediacy see the same final state.

---

### Task 6: Approvals bridge and live session updates

**Files:**
- Create: `src/approvals/approval-bridge.ts`, `tests/approval-bridge.spec.ts`
- Modify: `src/input.ts` (parse `agent.session.input.approval_response`), `src/types.ts` (the `OAIRequiredAction` union gains `{ type: 'approval'; id: string; kind: 'sandbox_escalation' | 'user_question' | 'tool_approval'; prompt: string; options: string[] }`), `src/gateway.ts` (`postEvents`, `updateSession`), `docs/http-api.md`

**Interfaces:**
- Consumes: `ctx.userQuestions` (`dsh-user-questions`) and the answerer registration of `dsh-user-approval`; the agent's model `select()` from `dsh-agent`
- Produces:
```ts
export interface ApprovalBridge {
  pending(sessionId: string): OAIRequiredAction[]
  answer(sessionId: string, approvalId: string, decision: 'approve' | 'deny' | 'answer', payload?: unknown): Promise<'resolved' | 'not_found'>
}
export function installApprovalBridge(ctx: Context, deps: { registry: SessionRegistry; onChange(sessionId: string): void }): ApprovalBridge
```

- [ ] **Step 1: Pin the DSH interaction types**

Read `$DSH_ROOT/packages/interaction/user-questions/README.md`, `$DSH_ROOT/packages/interaction/user-approval/README.md`, and their `src/index.ts`. Write the exact answerer registration call and request/answer types as the module JSDoc of `approval-bridge.ts` before writing code.

- [ ] **Step 2: Write the failing tests**
  - `escalation becomes requires_action` → a fake user-approval request for session S → `GET /agents/sessions/S` shows status `requires_action` with one `approval` action
  - `approve resumes` → POST `approval_response` with `decision: 'approve'` → the fake request resolves as approved; status leaves `requires_action`
  - `approval after cancel is not found` → cancel the session, then answer → `404 approval_not_found`
  - `model update applies live` → POST `{ model }` on a live session → the fake agent's `select()` is called with the new model; GET shows it
  - `unsupported live update is rejected` → a fake agent without `select` → `409 session_setting_not_live`; the stored model is unchanged

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run tests/approval-bridge.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement.** The bridge registers its answerer through `ctx.effect()` so plugin disposal unregisters it.

- [ ] **Step 5: Run the suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Docs and commit**

Add a CHANGELOG bullet and `docs/changes/2026-11-08-approvals.md`; document `approval_response` in `docs/http-api.md`.
```bash
git add -A && git commit -m "feat: approvals over the Agents API and live session model updates"
```

---

### Task 7: Request-reconstruction spike, then the admin API

**Files:**
- Create: `src/admin/request-reconstruction.ts`, `src/admin/admin-gateway.ts`, `tests/admin-request.spec.ts`, `tests/admin-gateway.spec.ts`
- Modify: `src/index.ts` (register the `/admin/v1` prefix route; add `'configEditor'` to `inject`), `README.md` (admin route table)
- Only if the spike fails: `src/store/migrations/0002-model-requests.sql`, `src/admin/request-capture.ts`, `AGENTS.md` decision 7

**Interfaces:**
- Consumes: `Store` (Task 4), `SessionHistory` (Task 5), `Authenticator` and `requireRole` (Task 3), `ctx.sessionQuery.{filterSessions, searchSessions, traceSession, listEvents}`, `ctx.configEditor.edit()`
- Produces:
```ts
export interface ModelRequest { system: string; tools: unknown[]; messages: unknown[]; model: string; parameters: Record<string, unknown> }
export function reconstructStepRequest(sessionQuery: SessionQueryService, dshSessionId: string, stepId: string): Promise<ModelRequest | undefined>
export class AdminGateway {
  constructor(ctx: Context, prefix: string, deps: { auth: Authenticator; store: Store; history: SessionHistory; reconstruct: typeof reconstructStepRequest })
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}
```

- [ ] **Step 1: Write the spike golden test** `rebuilt request equals provider request` in `tests/admin-request.spec.ts`: boot an in-process DSH host from `$DSH_ROOT` with a fake model provider that records every outgoing request; drive a 3-turn session with one tool call and one forced compaction; for every step, `reconstructStepRequest` deep-equals the recorded request.

- [ ] **Step 2: Implement `reconstructStepRequest`** from `listEvents` up to the step's position, applying DSH message projections and Session tool history; run the golden test.

- [ ] **Step 3: Decide**

PASS → continue to Step 4. FAIL after a focused attempt → stop and tell the user. Only with their approval, implement the capture fallback (`model_requests(session_id text, step_id text, body jsonb, bytes int, created_at timestamptz)`, config `admin.capture: { maxBytes, retentionDays }`) and amend AGENTS.md decision 7 in the same commit.

- [ ] **Step 4: Write the failing admin route tests** in `tests/admin-gateway.spec.ts`, covering every route in spec section 6.1:
  - `missing token gets 401`; `non-admin gets 403` on each route
  - `lists sessions across owners` with the `owner`, `status`, `from`/`to`, and `q` filters
  - `session detail includes trace tree`; `messages`; `steps` with usage; `steps/{id}/request` returns a `ModelRequest`; `log` paginates
  - `config PATCH validates` → an invalid value returns 400 and leaves `configEditor` untouched; a valid value calls `edit()`
  - `every admin call writes one audit row` (actor, action = `METHOD route-pattern`, target)

- [ ] **Step 5: Run them to verify they fail**

Run: `pnpm vitest run tests/admin-gateway.spec.ts`
Expected: FAIL.

- [ ] **Step 6: Implement `AdminGateway`** with the same `Route[]` / `matchRoute` pattern as `gateway.ts`.

- [ ] **Step 7: Run the suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Docs and commit**

Add a CHANGELOG bullet and `docs/changes/2026-11-08-admin-api.md`.
```bash
git add -A && git commit -m "feat(admin): admin API with full per-step model requests"
```

---

### Task 8: `agentry` profile, image, compose, startup checks

**Files:**
- Create: `deploy/profile/package.json`, `deploy/profile/cordis.patch.yml`, `deploy/Dockerfile`, `deploy/compose.yml`, `deploy/compose.simple.yml` (spec 7.3 simple-hosting variant: caddy + postgres + agentry with `auth.mode: apiKeys`, no Keycloak; verified with the same `/health` and sandbox-denial checks), `deploy/Caddyfile`, `deploy/keycloak/realm-agentry.json`, `deploy/postgres/init.sql`, `deploy/.env.example`, `deploy/backup/pg-dump.sh`, `deploy/backup/snapshot-dsh.sh`, `deploy/README.md`, `src/startup-checks.ts`, `tests/startup-checks.spec.ts`
- Modify: `cordis.patch.yml` (insert only the `agents-api` row), `src/index.ts` (run startup checks before registering routes), `.gitignore` (`deploy/.env`)

**Interfaces:**
- Consumes: `migrate` (Task 4), the Keycloak config (Task 3), `ctx.sandbox` from `dsh-sandbox-local`
- Produces:
```ts
export class StartupCheckError extends Error {
  code: 'missing_deepseek_key' | 'store_unreachable' | 'migration_failed' | 'keycloak_unreachable' | 'dev_key_in_production' | 'sandbox_unavailable'
}
export function runStartupChecks(deps: {
  env: NodeJS.ProcessEnv; mode: 'production' | 'development'
  migrate(): Promise<unknown>; jwksReachable(): Promise<boolean>
  sandboxProbe(): Promise<'full' | 'partial' | 'unavailable'>
}): Promise<{ enforcement: 'full' | 'partial' }>
```

- [ ] **Step 1: Write the failing tests** — one per `StartupCheckError.code`, plus `returns enforcement level when all checks pass`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/startup-checks.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `startup-checks.ts`**; on success log `sandbox enforcement: <level>`.

- [ ] **Step 4: Run the suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Write the deployment files** per spec sections 7.1–7.3:
  - Profile bundles `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@agentry/api"]`; every secret `!!js process.env.<NAME>`.
  - Dockerfile: build stage clones DSH at the tag in `dsh.pin`, runs `pnpm install --frozen-lockfile` and `pnpm run build:artifacts`, builds this package, installs the profile; runtime stage uses non-root user `agentry`, `ENTRYPOINT ["tini","--"]`, `CMD ["pnpm","dsh","--profile","agentry"]`, volumes `/data/dsh` and `/data/workspaces`.
  - Compose: `caddy`, `keycloak` (`start --import-realm`), `postgres:16-alpine` (`init.sql` creates databases `agentry` and `keycloak`), `agentry` on network `internal` only, with `runtime: runsc` present but commented out.
  - Caddy routes `/v1/*`, `/admin/v1/*`, and `/health` to `agentry`, and never `/`.
  - Realm `agentry` with roles `agentry-user` and `agentry-admin`, and one confidential client for the future BFF.

- [ ] **Step 6: Verify the stack**

Run: `cp deploy/.env.example deploy/.env` (fill in values), then `docker compose -f deploy/compose.yml up -d --build && curl -fsSk https://localhost/health`
Expected: `{"status":"ok"}`, and `docker compose -f deploy/compose.yml logs agentry` contains `sandbox enforcement: full` or `sandbox enforcement: partial`.

- [ ] **Step 7: Verify sandbox denial**

With a Keycloak token for a test user, create a session whose input asks the agent to run `touch /data/outside-workspace`.
Expected: the bash tool result reports a sandbox denial, and `docker compose exec agentry test -e /data/outside-workspace` exits 1.

- [ ] **Step 8: Docs and commit**

Add a CHANGELOG bullet and `docs/changes/2026-11-08-deployment.md`.
```bash
git add -A && git commit -m "feat(deploy): agentry profile, container, and compose stack"
```

---

### Task 9: OpenAPI contract and CI

**Files:**
- Create: `openapi/agentry.yaml`, `tests/openapi-drift.spec.ts`, `.github/workflows/ci.yml`
- Modify: `src/gateway.ts` and `src/admin/admin-gateway.ts` (expose `routeTable()`), `README.md` (link the OpenAPI file), `AGENTS.md` (Status: foundation done; next sub-project)

**Interfaces:**
- Produces: `routeTable(): ReadonlyArray<{ method: string; pattern: string }>` on `AgentsGateway` and `AdminGateway`; `openapi/agentry.yaml` as the frontend's contract

- [ ] **Step 1: Write the failing drift test** `routes and OpenAPI paths match`: convert `:param` and `*path` patterns to `{param}` and compare the set of `METHOD path` pairs for `/v1` and `/admin/v1` with `openapi/agentry.yaml` (parsed with `yaml`).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/openapi-drift.spec.ts`
Expected: FAIL (file missing).

- [ ] **Step 3: Write `openapi/agentry.yaml`** — OpenAPI 3.1 with both prefixes, bearer auth, and the error codes from Global Constraints.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run tests/openapi-drift.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the CI workflow** — check out this repo and DSH at `$(cat dsh.pin)` into `../dsh-pinned`, then `pnpm install`, `pnpm check:dsh-pin`, `pnpm typecheck`, `pnpm test` (Docker is available on `ubuntu-latest` for Testcontainers), `pnpm build`.

- [ ] **Step 6: Run the full local gate**

Run: `pnpm check:dsh-pin && pnpm typecheck && pnpm test && pnpm build`
Expected: every command succeeds.

- [ ] **Step 7: Final live check**

Repeat Task 1 Step 3, then run `quickstart.py`, `save_agents_smoke.py`, and `sandbox_smoke.py` against the compose stack with a Keycloak token in `DSH_AGENTS_API_KEY`.
Expected: all four complete.

- [ ] **Step 8: Docs and commit**

Add a CHANGELOG bullet and update the AGENTS.md Status section.
```bash
git add -A && git commit -m "ci: OpenAPI contract and CI pipeline"
```
