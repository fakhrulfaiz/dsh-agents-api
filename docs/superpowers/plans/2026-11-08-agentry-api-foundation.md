# Agentry API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `dsh-agents-api` into `@agentry/api`: an OpenAI Agents API–compatible DSH plugin with Keycloak auth, Postgres storage, restart-safe history, approvals, an admin API, and a one-container VM deployment.

**Architecture:** The plugin keeps its existing route table in `src/gateway.ts` and adds four seams behind interfaces: `Authenticator` (Keycloak / development key), `Store` (Postgres), `SessionHistory` (DSH Session log via `ctx.sessionQuery`), and `ApprovalBridge` (DSH interaction answerers). A second route table serves `/admin/v1`. Deployment is one `agentry` DSH profile in a Docker image, composed with Caddy, Keycloak, and Postgres.

**Tech Stack:** TypeScript (ESM, strict), Cordis/DSH plugin APIs, vitest, `pg`, `jose`, `@testcontainers/postgresql`, tsdown, Docker Compose, Caddy, Keycloak.

**Spec:** [docs/superpowers/specs/2026-11-08-agentry-api-foundation-design.md](../specs/2026-11-08-agentry-api-foundation-design.md). Decisions: [AGENTS.md](../../../AGENTS.md).

## Global Constraints

- DSH pin: `dsh-v0.2.2-rc.1`, recorded in `dsh.pin`. Development resolves DSH sources from `$DSH_ROOT` (default `../deepseek-harness`). Create the pinned tree with `git -C ../deepseek-harness worktree add ../dsh-pinned dsh-v0.2.2-rc.1` and export `DSH_ROOT=../dsh-pinned`. Never edit files under `$DSH_ROOT`.
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
- Create: `deploy/profile/package.json`, `deploy/profile/cordis.patch.yml`, `deploy/Dockerfile`, `deploy/compose.yml`, `deploy/Caddyfile`, `deploy/keycloak/realm-agentry.json`, `deploy/postgres/init.sql`, `deploy/.env.example`, `deploy/backup/pg-dump.sh`, `deploy/backup/snapshot-dsh.sh`, `deploy/README.md`, `src/startup-checks.ts`, `tests/startup-checks.spec.ts`
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
