/**
 * OpenAI Agents API REST gateway for DeepSeek Harness.
 *
 * Official `OpenAI-Beta: agents=v1` routes implemented:
 * - Agents: `POST|GET /v1/agents`, `GET|POST|DELETE /v1/agents/{agent_id}`
 * - Host tools catalog: `GET /v1/agents/tools`
 * - Skill catalog: `GET /v1/agents/skills`
 * - Command catalog: `GET /v1/agents/commands`
 * - Files: `POST /v1/agents/files`, `GET /v1/agents/files/{file_id}/content`, `DELETE /v1/agents/files/{file_id}`
 * - Sessions: `POST|GET /v1/agents/sessions`, `GET|POST|DELETE /v1/agents/sessions/{session_id}`
 * - Events: `POST|GET /v1/agents/sessions/{session_id}/events`
 * - Items: `GET /v1/agents/sessions/{session_id}/items`
 * - Turns: `GET /v1/agents/sessions/{session_id}/turns`, `GET /v1/agents/sessions/{session_id}/turns/{turn_id}`
 * - Environments, artifacts, and subagents under the same prefix
 * - `GET /health` on the webserver, outside `/v1`: 200 once the store is open, 503 before or after a failed start
 *
 * Reference: https://developers.openai.com/api/docs/guides/agents-api
 *
 * @module @agentry/api
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadBuiltins, type BuiltinSkill } from './skills/resolve.ts'
import { ComposioRelay, RELAY_PATH_PREFIX, relayEnabled } from './composio-relay.ts'
import { DEFAULT_APPROVAL_VERBS } from './mount-composio.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { firstThen, type Authenticator, type OwnerId } from './auth/authenticator.ts'
import { API_KEY_HASH_PATTERN, createApiKeyAuthenticator, type ApiKeyEntry } from './auth/api-keys.ts'
import { createKeycloakAuthenticator } from './auth/keycloak.ts'
import { createStaticKeyAuthenticator } from './auth/static-key.ts'
import { claimAgent, installApprovalBridge } from './approvals/approval-bridge.ts'
import { bridgeChildSessionEvent } from './bridge.ts'
import { createLocalProvider, directorySegment } from './environment/local.ts'
import { createAgentrySandboxProvider } from './sandbox/agentry-sandbox-provider.ts'
import { agentryPresetRows, createSandboxPresets, setSandboxCredentials, setSandboxPrepare, type PresetRegistryLike, type SandboxPresets } from './sandbox/presets.ts'
import { copySkillsInto } from './sandbox/skills-copy.ts'
import { createSandboxApi } from '@agentry/sandbox/client'
import { SandboxRegistry } from './sandbox/registry.ts'
import { DEFAULT_ALLOWED_MEDIA_TYPES, stagingDirectory, validateUploads, type UploadsConfig } from './files/config.ts'
import { createFilesystemFileStore, type FileStore } from './files/file-store.ts'
import { startSweeper } from './files/sweeper.ts'
import { AgentsGateway } from './gateway.ts'
import type { OfficeToPdfLike } from './render/office-api.ts'
import type { WorkspaceChangesLike } from './history/turn-changes.ts'
import { errorMessage } from './http.ts'
import { createSessionHistory } from './history/session-history.ts'
import { recoverSessions, recoveryUnavailable } from './recovery.ts'
import { installScheduleResolver } from './schedule-resolver.ts'
import { CodeboxRemovedError, resolveRuntimeConfig, type RuntimeConfigInput } from './runtime-config.ts'
import { SessionRegistry } from './session-registry.ts'
import { migrate } from './store/migrate.ts'
import { openPostgresStore } from './store/postgres.ts'
import { StoreStartError, type Store } from './store/store.ts'

export * from './types.ts'
export * from './sse.ts'
export * from './agent-records.ts'
export * from './session-registry.ts'
export * from './items.ts'
export * from './http.ts'
export * from './input.ts'
export * from './bridge.ts'
export * from './history/projector.ts'
export * from './history/session-history.ts'
export * from './recovery.ts'
export * from './schedule-resolver.ts'
export * from './approvals/approval-bridge.ts'
export * from './session-resource.ts'
export * from './gateway.ts'
export * from './errors.ts'
export * from './pending-function-calls.ts'
export * from './mount-function-tools.ts'
export * from './mount-instructions.ts'
export * from './mount-mcp-tools.ts'
export * from './host-tools.ts'
export * from './environment-types.ts'
export * from './runtime-config.ts'
export * from './artifacts.ts'
export * from './files/config.ts'
export * from './files/file-store.ts'
export * from './files/names.ts'
export * from './files/sniff.ts'
export * from './files/content.ts'
export * from './files/note.ts'
export * from './files/ingest.ts'
export * from './files/item-parts.ts'
export * from './files/sweeper.ts'
export * from './files/attached.ts'
export * from './files/api.ts'
export * from './store/store.ts'
export { migrate, MigrationError } from './store/migrate.ts'
export { openPostgresStore } from './store/postgres.ts'
export * from './environment/provider.ts'
export { createLocalProvider, directorySegment } from './environment/local.ts'
export { SandboxRegistry, UnknownSandboxProviderError } from './sandbox/registry.ts'
export type { SandboxCapabilities, SandboxProvider, TemplateField } from './sandbox/contract.ts'
export { bearerToken, firstThen, ownerId, requireAnyRole, requireRole, unauthenticated } from './auth/authenticator.ts'
export type { AuthResult, Authenticator, OwnerId, Principal, Role as AuthRole } from './auth/authenticator.ts'
export { createKeycloakAuthenticator, type KeycloakAuthConfig } from './auth/keycloak.ts'
export { createStaticKeyAuthenticator } from './auth/static-key.ts'
export { createApiKeyAuthenticator, generateApiKey, hashApiKey, type ApiKeyEntry } from './auth/api-keys.ts'

/** Cordis plugin name. */
export const name = 'agents-api'

/** Host services required before routes can register. */
export const inject = ['webServer', 'sessions', 'agents', 'agentDefaultModel', 'tools', 'sessionQuery', 'sessionPersistence', 'llm', 'approval', 'userQuestions']

/** Resolved Keycloak settings: every field present after `Config` defaults. */
export interface ResolvedKeycloakConfig {
  issuer: string
  audience: string
  jwksTtlSeconds: number
  jwksCooldownSeconds: number
  algorithms: string[]
  clockToleranceSeconds: number
}

/** Resolved `auth` block: `Config` output with defaults applied. */
export interface ResolvedAuthConfig {
  mode: 'production' | 'apiKeys' | 'development'
  keycloak?: ResolvedKeycloakConfig
  devKey?: { key: string; owner: string; admin: boolean }
  apiKeys?: ApiKeyEntry[]
}

/** JWS algorithms accepted in `auth.keycloak.algorithms`. */
export const ALLOWED_ALGORITHMS: readonly string[] = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']

/** Plugin configuration as written in cordis.yml. `workspaces` is required; omitted artifact backends stay off and env fills them in. */
export interface Config extends RuntimeConfigInput {
  /** Authentication. Required: `production` verifies Keycloak tokens, `apiKeys` accepts named keys, `development` accepts a fixed key. */
  auth?: {
    /**
     * `production` requires `keycloak` and forbids `devKey` and `apiKeys`;
     * `apiKeys` requires a non-empty `apiKeys` list, accepts `keycloak` as a second credential, and forbids `devKey`;
     * `development` needs `devKey` or `keycloak` and forbids `apiKeys`.
     */
    mode: 'production' | 'apiKeys' | 'development'
    /** Keycloak realm verification. */
    keycloak?: {
      /** Realm issuer URL, matched against the token `iss`; JWKS lives at `${issuer}/protocol/openid-connect/certs`. */
      issuer: string
      /** Required token `aud`. */
      audience: string
      /** JWKS cache lifetime in seconds (default 600). */
      jwksTtlSeconds?: number
      /** Minimum seconds between JWKS refetches caused by an unknown `kid` (default 30). */
      jwksCooldownSeconds?: number
      /** Accepted JWS algorithms, non-empty subset of `ALLOWED_ALGORITHMS` (default `['RS256']`). */
      algorithms?: string[]
      /** Allowed clock skew in seconds (default 5). */
      clockToleranceSeconds?: number
    }
    /** Named API keys for simple self-hosting (mode `apiKeys`). Config holds hashes only; create entries with `pnpm keys:create`. */
    apiKeys?: ApiKeyEntry[]
    /** Fixed development bearer key. */
    devKey?: {
      key: string
      /** Owner id the key acts as. */
      owner: string
      /** Grant the `agentry-admin` role (default true). */
      admin?: boolean
    }
  }
  /** Skill catalog served by `GET /agents/skills`. */
  skills?: {
    /** Seconds the catalog is cached in memory; 0 disables caching (default 60). Finite and non-negative. */
    cacheTtlSeconds?: number
    /** Folder of installed (library and private) skills (default `~/.dsh/agentry-skills`). */
    dir?: string
    /** Folder of Agentry's built-in skills (default this package's `skills/`). */
    builtinDir?: string
    /** Show skills from session workspaces' `.agents/skills` folders (default false). */
    workspaceSkills?: boolean
  }
  /** Composio connected apps: grant enforcement and approvals for writes on the user's behalf. */
  composio?: {
    /** MCP server label of the Composio tools (default `composio`). */
    serverLabel?: string
    /** Tool-slug words that mean a write; such calls ask first under `send_policy: ask` (default: send, create, update, delete and similar). */
    approvalVerbs?: string[]
    /** Extra tool slugs that always ask first (default none). */
    approvalSlugs?: string[]
  }
  /** The web browser (Playwright MCP). It runs only inside Agentry Sandbox chats; there is no host browser. */
  browser?: {
    /** What agents whose `browser` field is absent or null get: `auto` (when the chat's sandbox has the browser), `on` or `off`; `true`/`false` mean on/off (default `auto`). */
    default?: 'auto' | 'on' | 'off' | boolean
    /** Most frames a second the live browser view (`/agents/sessions/{id}/browser/live`) sends, 1 to 15 (default 10). */
    liveFps?: number
  }
  /** Slash-command catalog served by `GET /agents/commands`. */
  commands?: {
    /** Seconds a catalog is cached in memory; 0 disables caching (default 60). Finite and non-negative. */
    cacheTtlSeconds?: number
    /** Command names Agentry lists and runs; others answer 404 (default `goal`, `plan`, `compact`, `export`). */
    allow?: string[]
  }
  /**
   * File uploads for chat attachments. Without `dir`, `POST /agents/files` answers 501 `uploads_disabled`.
   * Set `dir` to a directory outside `workspaces`; startup fails when it cannot be created or written.
   */
  uploads?: Partial<UploadsConfig>
  /** API path prefix (default `/v1`). */
  prefix?: string
  /** Agentry's Postgres database. Required. */
  database?: {
    /** Connection URL, for example `postgres://agentry:…@postgres:5432/agentry`. */
    url: string
  }
  /** Rejected with `CodeboxRemovedError`: Codebox was removed. */
  codebox?: unknown
  /** Rejected: removed when records moved from JSON files to Postgres (`database.url`). */
  dataDir?: unknown
}

/** `Config` after validation: `auth`, `prefix`, `database`, and `workspaces` are always present; `codebox` and `dataDir` never are. */
export type ResolvedConfig = Omit<Config, 'auth' | 'prefix' | 'database' | 'codebox' | 'dataDir' | 'skills' | 'commands' | 'uploads' | 'composio' | 'browser'> & {
  auth: ResolvedAuthConfig
  browser: { default: 'auto' | 'on' | 'off' | boolean; liveFps: number }
  skills: { cacheTtlSeconds: number; dir: string; builtinDir: string; workspaceSkills: boolean }
  commands: { cacheTtlSeconds: number; allow: string[] }
  composio: { serverLabel: string; approvalVerbs: string[]; approvalSlugs: string[] }
  uploads: UploadsConfig
  prefix: string
  database: { url: string }
}

/** Installed skills folder when `skills.dir` is not set. */
export const DEFAULT_SKILLS_DIR = `${process.env['HOME'] ?? ''}/.dsh/agentry-skills`

/** This package's `skills/` folder, beside `lib/` in a build and beside `src/` in a checkout. */
export const DEFAULT_BUILTIN_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/** Host skill sources hidden from Agentry: developer skill folders. `project-*` returns with `skills.workspaceSkills`. */
export const DEVELOPER_SKILL_SOURCES: readonly string[] = ['user-dsh', 'user-agents', 'project-dsh', 'project-agents']

/** Slash commands Agentry exposes by default; DSH's `/permission` and `/feedback` stay hidden. */
export const DEFAULT_COMMANDS_ALLOW: readonly string[] = ['goal', 'plan', 'compact', 'export']

/** Schemastery types `.default` as the object's value; `null` is how an optional nested object is left absent at runtime. */
const ABSENT = null as never

/** Validate and default plugin configuration. */
export const Config: z<Config, ResolvedConfig> = z.transform(z.object({
  auth: z.object({
    mode: z.union([z.const('production'), z.const('apiKeys'), z.const('development')]).required(),
    keycloak: z.object({
      issuer: z.string().required(),
      audience: z.string().required(),
      jwksTtlSeconds: z.number().default(600),
      jwksCooldownSeconds: z.number().default(30),
      algorithms: z.array(z.string()).default(['RS256']),
      clockToleranceSeconds: z.number().default(5),
    }).default(ABSENT),
    apiKeys: z.array(z.object({
      name: z.string().required(),
      owner: z.string().required(),
      roles: z.array(z.string()).required(),
      hash: z.string().required(),
    })).default(ABSENT),
    devKey: z.object({
      key: z.string().required(),
      owner: z.string().required(),
      admin: z.boolean().default(true),
    }).default(ABSENT),
  }).default(ABSENT),
  skills: z.object({
    cacheTtlSeconds: z.number().default(60),
    dir: z.string().default(DEFAULT_SKILLS_DIR),
    builtinDir: z.string().default(DEFAULT_BUILTIN_SKILLS_DIR),
    workspaceSkills: z.boolean().default(false),
  }).default({ cacheTtlSeconds: 60, dir: DEFAULT_SKILLS_DIR, builtinDir: DEFAULT_BUILTIN_SKILLS_DIR, workspaceSkills: false }),
  commands: z.object({
    cacheTtlSeconds: z.number().default(60),
    allow: z.array(z.string()).default([...DEFAULT_COMMANDS_ALLOW]),
  }).default({ cacheTtlSeconds: 60, allow: [...DEFAULT_COMMANDS_ALLOW] }),
  browser: z.object({
    default: z.union([z.boolean(), z.const('auto'), z.const('on'), z.const('off')]).default('auto'),
    liveFps: z.number().default(10),
  }).default({ default: 'auto', liveFps: 10 }),
  composio: z.object({
    serverLabel: z.string().default('composio'),
    approvalVerbs: z.array(z.string()).default([...DEFAULT_APPROVAL_VERBS]),
    approvalSlugs: z.array(z.string()).default([]),
  }).default({ serverLabel: 'composio', approvalVerbs: [...DEFAULT_APPROVAL_VERBS], approvalSlugs: [] }),
  uploads: z.object({
    dir: z.string(),
    maxFileBytes: z.number().default(25 * 1024 * 1024),
    maxFilesPerMessage: z.number().default(10),
    maxMessageBytes: z.number().default(50 * 1024 * 1024),
    maxStagedBytesPerOwner: z.number().default(500 * 1024 * 1024),
    stagedTtlMinutes: z.number().default(1440),
    sweepIntervalMinutes: z.number().default(15),
    allowedMediaTypes: z.array(z.string()).default([...DEFAULT_ALLOWED_MEDIA_TYPES]),
  }).default({
    maxFileBytes: 25 * 1024 * 1024,
    maxFilesPerMessage: 10,
    maxMessageBytes: 50 * 1024 * 1024,
    maxStagedBytesPerOwner: 500 * 1024 * 1024,
    stagedTtlMinutes: 1440,
    sweepIntervalMinutes: 15,
    allowedMediaTypes: [...DEFAULT_ALLOWED_MEDIA_TYPES],
  } as UploadsConfig),
  prefix: z.string().default('/v1'),
  database: z.object({
    url: z.string().required(),
  }).required(),
  // Declared only so the transform can reject them by name.
  dataDir: z.any(),
  codebox: z.any(),
  workspaces: z.string().required(),
  artifacts: z.object({
    endpoint: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    region: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
  }).default(ABSENT),
  sandbox: z.object({
    url: z.string(),
    key: z.string(),
  }).default(ABSENT),
}), (config) => {
  validateAuth(config.auth as ResolvedAuthConfig | undefined)
  if (typeof config.workspaces !== 'string' || config.workspaces.trim() === '') throw new Error('agents-api: "workspaces" must not be empty')
  const ttl = (config.skills as { cacheTtlSeconds: number }).cacheTtlSeconds
  if (!Number.isFinite(ttl) || ttl < 0) throw new Error('agents-api: "skills.cacheTtlSeconds" must be a finite number >= 0')
  const commandsTtl = (config.commands as { cacheTtlSeconds: number }).cacheTtlSeconds
  if (!Number.isFinite(commandsTtl) || commandsTtl < 0) throw new Error('agents-api: "commands.cacheTtlSeconds" must be a finite number >= 0')
  validateUploads(config.uploads as UploadsConfig)
  if (config.codebox !== undefined && config.codebox !== null) throw new CodeboxRemovedError('the "codebox" config block')
  if (config.dataDir !== undefined && config.dataDir !== null) {
    throw new Error('agents-api: "dataDir" was removed; agents, environments, and the session index live in Postgres (database.url)')
  }
  return config
}, true) as unknown as z<Config, ResolvedConfig>

/** Roles accepted in `auth.apiKeys[].roles`. */
const API_KEY_ROLES: readonly string[] = ['agentry-user', 'agentry-admin']

/**
 * Check `auth.apiKeys` entries.
 * @param apiKeys - entries from the `auth` block.
 * @throws when the list is empty, a name or owner is empty or a name repeats, a hash is not `sha256:` plus 64 lowercase hex characters, or roles are empty or unknown.
 */
function validateApiKeys(apiKeys: readonly ApiKeyEntry[]): void {
  if (apiKeys.length === 0) throw new Error('agents-api: auth.apiKeys must not be empty when auth.mode is "apiKeys"')
  const names = new Set<string>()
  apiKeys.forEach((entry, index) => {
    const where = `auth.apiKeys[${String(index)}]`
    if (!entry.name) throw new Error(`agents-api: ${where}.name must not be empty`)
    if (names.has(entry.name)) throw new Error(`agents-api: ${where} has duplicate name "${entry.name}"`)
    names.add(entry.name)
    if (!entry.owner) throw new Error(`agents-api: ${where}.owner must not be empty`)
    if (!API_KEY_HASH_PATTERN.test(entry.hash)) throw new Error(`agents-api: ${where}.hash must be "sha256:" followed by 64 lowercase hex characters`)
    if (entry.roles.length === 0) throw new Error(`agents-api: ${where}.roles must not be empty`)
    const unknown = entry.roles.filter(role => !API_KEY_ROLES.includes(role))
    if (unknown.length > 0) throw new Error(`agents-api: ${where}.roles has unsupported entries: ${unknown.join(', ')}`)
  })
}

/**
 * Check the `auth` block for contradictory or missing settings.
 * @param auth - validated `auth` block.
 * @throws when `auth` is missing, `keycloak.algorithms` is empty or names an unsupported algorithm, `production` lacks `keycloak` or sets `devKey` or `apiKeys`, `apiKeys` mode lacks valid entries or sets `devKey`, `development` has neither `devKey` nor `keycloak` or sets `apiKeys`, or `devKey.key` is empty.
 */
export function validateAuth(auth: ResolvedAuthConfig | undefined): void {
  if (auth === undefined) throw new Error('agents-api: "auth" is required (set auth.mode to production, apiKeys, or development)')
  const { mode, keycloak, devKey, apiKeys } = auth
  if (mode === 'production') {
    if (devKey !== undefined) throw new Error('agents-api: auth.devKey is not allowed when auth.mode is "production"')
    if (apiKeys !== undefined) throw new Error('agents-api: auth.apiKeys is not allowed when auth.mode is "production"; use mode "apiKeys"')
    if (keycloak === undefined) throw new Error('agents-api: auth.keycloak is required when auth.mode is "production"')
  } else if (mode === 'apiKeys') {
    if (devKey !== undefined) throw new Error('agents-api: auth.devKey is not allowed when auth.mode is "apiKeys"')
    if (apiKeys === undefined) throw new Error('agents-api: auth.apiKeys is required when auth.mode is "apiKeys"')
    validateApiKeys(apiKeys)
  } else {
    if (apiKeys !== undefined) throw new Error('agents-api: auth.apiKeys is not allowed when auth.mode is "development"; use mode "apiKeys"')
    if (devKey === undefined && keycloak === undefined) throw new Error('agents-api: auth.mode "development" needs auth.devKey or auth.keycloak')
  }
  if (keycloak !== undefined) {
    const unknown = keycloak.algorithms.filter(name => !ALLOWED_ALGORITHMS.includes(name))
    if (keycloak.algorithms.length === 0) throw new Error('agents-api: auth.keycloak.algorithms must not be empty')
    if (unknown.length > 0) throw new Error(`agents-api: auth.keycloak.algorithms has unsupported entries: ${unknown.join(', ')}`)
  }
  if (devKey !== undefined && !devKey.key) throw new Error('agents-api: auth.devKey.key must not be empty')
}

/**
 * Build the request authenticator from the resolved `auth` block.
 * @param auth - `auth` block from `Config` output.
 * @param warn - receives Keycloak rejection diagnostics.
 * @returns the authenticator for `auth.mode`: Keycloak; API keys, then Keycloak when `keycloak` is also set; or the dev key, then Keycloak when `keycloak` is also set.
 */
export function createAuthenticator(auth: ResolvedAuthConfig, warn: (message: string) => void): Authenticator {
  validateAuth(auth)
  const { keycloak, devKey, apiKeys } = auth
  const verifier = keycloak === undefined ? undefined : createKeycloakAuthenticator({ ...keycloak, warn })
  const local = apiKeys !== undefined
    ? createApiKeyAuthenticator(apiKeys)
    : devKey === undefined ? undefined : createStaticKeyAuthenticator(devKey)
  if (local !== undefined && verifier !== undefined) return firstThen(local, verifier)
  return (local ?? verifier)!
}

/**
 * Register the Agents API prefix route and Session-event bridge, then migrate,
 * open the Postgres store, and recover sessions that were running at shutdown
 * in the background. Scheduled deliveries (`schedule/resolve-agent`) to a
 * session in the index resume it through the gateway; the schedule service is
 * optional and read at call time. Until the store is open `/v1` answers 503
 * `store_unavailable`; when migration, connection, or recovery fails, a
 * `StoreStartError` is logged and `/v1` keeps answering 503 with its message.
 * @param ctx - plugin context with `webServer`, `sessions`, `agents`, `agentDefaultModel`, `tools`, `sessionQuery`, and `sessionPersistence`.
 * @param config - validated config.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const prefix = config.prefix
  const runtime = resolveRuntimeConfig(config)
  const stagingDir = stagingDirectory(config.uploads, runtime.workspacesRoot)
  const staging = stagingDir === undefined ? undefined : createFilesystemFileStore(stagingDir)
  const sessionRegistry = new SessionRegistry()
  const approvals = installApprovalBridge(ctx, {
    claims: agent => claimAgent(agent, id => sessionRegistry.get(id) !== undefined),
    onChange: (sessionId, actions) => gateway.setInteractionActions(sessionId, actions),
  })
  let builtinSkills: readonly BuiltinSkill[] = []
  void loadBuiltins(config.skills.builtinDir).then((loaded) => {
    builtinSkills = loaded
    if (loaded.length === 0) ctx.logger.warn(`agents-api: no built-in skills under ${config.skills.builtinDir}`)
  })
  const sandboxes = new SandboxRegistry('local')
  sandboxes.register(createLocalProvider(runtime.workspacesRoot))
  let sandboxPresets: SandboxPresets | undefined
  if (runtime.sandbox !== undefined) {
    const sandboxConfig = runtime.sandbox
    sandboxes.register(createAgentrySandboxProvider({ ...sandboxConfig, workspacesRoot: runtime.workspacesRoot }))
    setSandboxCredentials(sandboxConfig)
    ctx.effect(() => () => { setSandboxCredentials(undefined) })
    const patch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
    const rows = agentryPresetRows(patch)
    // Skills are copied whenever a sandbox's helper starts (first use, after a stop, reset or idle close).
    setSandboxPrepare(async (owner, sandboxId) => {
      const api = createSandboxApi({ ...sandboxConfig, owner })
      const copied = await copySkillsInto(api, sandboxId, [join(config.skills.dir, directorySegment(owner as OwnerId, 'owner')), config.skills.builtinDir])
      ctx.logger.info(`agents-api: sandbox ${sandboxId}: ${String(copied)} skill files copied`)
    })
    ctx.effect(() => () => { setSandboxPrepare(undefined) })
    sandboxPresets = createSandboxPresets({
      presets: () => ctx.get('agentPresets') as PresetRegistryLike | undefined,
      rows: () => rows,
    })
    ctx.effect(() => () => { void sandboxPresets?.dispose() })
  }
  const relay = relayEnabled()
    ? new ComposioRelay({
      serverLabel: config.composio.serverLabel,
      origin: () => ctx.webServer.getOrigin(),
      cacheDir: process.env['AGENTRY_COMPOSIO_RELAY_CACHE_DIR'] ?? `${process.env['HOME'] ?? ''}/.dsh/agentry-composio-relay`,
      warn: message => ctx.logger.warn(message),
    })
    : undefined
  const gateway = new AgentsGateway(ctx, createAuthenticator(config.auth, message => ctx.logger.warn(message)), prefix, undefined, sessionRegistry, {
    sandboxes,
    ...(sandboxPresets === undefined ? {} : { sandboxPresets }),
    workspacesRoot: runtime.workspacesRoot,
    runtimeInfoPath: `${process.env['AGENTRY_OFFICE_RUNTIME'] ?? `${process.env['HOME'] ?? ''}/.dsh/office-runtime/primary-runtime`}/runtime.json`,
    history: createSessionHistory(ctx.sessionQuery),
    approvals,
    schedule: () => ctx.get('schedule'),
    skills: () => ctx.get('skills'),
    skillsTtlMs: config.skills.cacheTtlSeconds * 1000,
    commands: () => ctx.get('commands'),
    commandsTtlMs: config.commands.cacheTtlSeconds * 1000,
    commandsAllow: config.commands.allow,
    builtinSkills: () => builtinSkills,
    skillsRoot: config.skills.dir,
    composio: config.composio,
    ...(relay === undefined ? {} : { composioRelay: relay }),
    browserDefault: config.browser.default,
    browserLiveFps: config.browser.liveFps,
    skillsHiddenSources: DEVELOPER_SKILL_SOURCES.filter(source => !(config.skills.workspaceSkills && source.startsWith('project-'))),
    ...(runtime.artifacts === undefined ? {} : { artifacts: runtime.artifacts }),
    ...(staging === undefined ? {} : { files: { staging, limits: config.uploads } }),
    attachments: () => ctx.get('attachments'),
    officeToPdf: () => ctx.get('officeToPdf') as OfficeToPdfLike | undefined,
    workspaceChanges: () => ctx.get('workspaceChanges') as WorkspaceChangesLike | undefined,
  })

  if (staging !== undefined) ctx.effect(() => verifyStaging(staging, stagingDir!), 'agents-api: upload staging')

  const sweep = staging === undefined
    ? undefined
    : { staging, ttlMs: config.uploads.stagedTtlMinutes * 60_000, intervalMs: config.uploads.sweepIntervalMinutes * 60_000 }
  ctx.effect(() => openStore(ctx, config.database.url, gateway, sweep), 'agents-api: postgres store')

  ctx.effect(() => {
    // Staged skills not reviewed within a day are deleted; the first sweep waits for the store to open.
    const first = setTimeout(() => { void gateway.sweepSkills() }, 60_000)
    const timer = setInterval(() => { void gateway.sweepSkills() }, 3_600_000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, 'agents-api: staged skill sweep')

  installScheduleResolver(ctx, sessionId => gateway.agentFor(sessionId))

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const parent = session.header?.parentSession
    if (session.header?.origin === 'subagent' && parent && sessionRegistry.get(parent)) {
      bridgeChildSessionEvent(parent, session.id, event, sessionRegistry, session.header.createdAt)
      return
    }
    gateway.applySessionEvent(session.id, event)
  })
  // A sandbox session's tools wait for its turn-start snapshot (src/history/sandbox-changes.ts), as DSH's recorder does for local ones.
  ctx.on('tools/pre-execute', (async (exec: { agent?: { session?: { id?: unknown } } }, next: () => Promise<unknown>) => {
    const id = exec.agent?.session?.id
    if (id !== undefined) await gateway.changesSettled(String(id))
    return next()
  }) as never)
  // While the user has control of a chat's browser (live view take-over), its browser tools wait; after a
  // hand-back the agent is told to look at the page again (src/sandbox/browser-control.ts).
  ctx.on('tools/pre-execute', (async (exec: { name: string; signal?: AbortSignal; agent?: { session?: { id?: unknown } } }, next: () => Promise<unknown>) => {
    const id = exec.agent?.session?.id
    if (id === undefined || !exec.name.startsWith('mcp__browser__')) return next()
    const decision = await gateway.browserToolGate(String(id), exec.name, exec.signal)
    return decision.kind === 'allow' ? next() : decision
  }) as never)
  ctx.on('tools/post-execute', (async (exec: { name: string; agent?: { session?: { id?: unknown } } }, result: { isError?: boolean; content?: ReadonlyArray<{ type?: string }> }, next: () => Promise<{ kind: string; content?: unknown }>) => {
    const decision = await next()
    const id = exec.agent?.session?.id
    if (id === undefined || decision.kind !== 'accept' || !exec.name.startsWith('mcp__browser__')) return decision
    const note = gateway.browserLookNote(String(id), exec.name, result.isError === true)
    if (note === undefined) return decision
    const content = Array.isArray(decision.content) ? decision.content as unknown[] : [...(result.content ?? [])]
    return { ...decision, content: [{ type: 'text', text: note }, ...content] }
  }) as never)
  ctx.on('commands/change', () => {
    gateway.invalidateCommands()
  })
  ctx.on('session/disposed', (session: Session) => {
    const parent = session.header?.parentSession
    if (session.header?.origin === 'subagent' && parent) {
      sessionRegistry.closeSubagent(parent, session.id)
    }
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/health',
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        const { status, body } = healthResponse(gateway.storeStatus())
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(body))
      },
    }),
    'agents-api: /health',
  )

  if (relay !== undefined) {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'prefix',
        path: RELAY_PATH_PREFIX,
        handler: (req: IncomingMessage, res: ServerResponse) => relay.handle(req, res),
      }),
      'agents-api: composio relay',
    )
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: (req: IncomingMessage, res: ServerResponse) => gateway.handle(req, res),
    }),
    `agents-api: ${prefix}`,
  )
}

/**
 * The `/health` answer: 200 once the store is attached (so `/v1` can serve), 503 while it
 * opens or after it failed to start. Container health checks and launchers wait on it.
 * @param store - the gateway's store state.
 * @returns status code and JSON body.
 */
export function healthResponse(store: ReturnType<AgentsGateway['storeStatus']>): { status: number; body: Record<string, unknown> } {
  if (store.state === 'ready') return { status: 200, body: { ok: true, service: 'agents-api' } }
  return { status: 503, body: { ok: false, service: 'agents-api', store: store.state, ...(store.state === 'failed' ? { error: store.error } : {}) } }
}

/**
 * Prove the staging directory is writable.
 * @param staging - staging byte store.
 * @param dir - its directory, for the message.
 * @returns the effect disposer (nothing to undo).
 * @throws Error naming the directory when it cannot be created or written.
 */
export async function verifyStaging(staging: FileStore, dir: string): Promise<() => void> {
  try {
    await staging.verify()
  } catch (error: unknown) {
    throw new Error(`agents-api: "uploads.dir" (${dir}) is not writable: ${errorMessage(error)}`, { cause: error })
  }
  return () => undefined
}

/**
 * Migrate, open, and attach the store; the returned disposer detaches and closes it.
 * @param ctx - plugin context, for logging.
 * @param url - Postgres connection URL.
 * @param gateway - gateway that serves from the store.
 * @param sweep - staging bytes, TTL, and interval of the upload sweeper started once the store is attached; `undefined` when uploads are off.
 * @returns the effect disposer.
 * @throws StoreStartError after recording it on the gateway and logging it.
 */
async function openStore(
  ctx: Context,
  url: string,
  gateway: AgentsGateway,
  sweep: { staging: FileStore; ttlMs: number; intervalMs: number } | undefined,
): Promise<() => Promise<void>> {
  let store: Store
  try {
    await migrate(url)
    store = await openPostgresStore(url, error => ctx.logger.warn(`agents-api: idle Postgres connection failed: ${error.message}`))
  } catch (error: unknown) {
    const failure = new StoreStartError(error)
    gateway.failStore(failure.message)
    ctx.logger.error(failure)
    throw failure
  }
  let unavailable: ReturnType<typeof recoveryUnavailable>
  try {
    unavailable = recoveryUnavailable(ctx.agents, ctx.sessionPersistence)
  } catch (error: unknown) {
    const failure = new StoreStartError(error)
    gateway.failStore(failure.message)
    await store.close()
    ctx.logger.error(failure)
    throw failure
  }
  gateway.attachStore(store)
  if (unavailable !== undefined) {
    ctx.logger.warn(`agents-api: recovery: skipped (${unavailable.message}); rows are left as they are and sessions resume lazily`)
  } else {
    try {
      const recovered = await recoverSessions({ store, resume: row => gateway.resumeSession(row) })
      ctx.logger.info(`agents-api: recovery: resumed ${String(recovered.resumed.length)}, interrupted ${String(recovered.interrupted.length)}`)
      for (const { id, reason } of recovered.interrupted) ctx.logger.warn(`agents-api: session ${id} marked interrupted: ${reason}`)
    } catch (error: unknown) {
      ctx.logger.error(`agents-api: session recovery stopped early: ${errorMessage(error)}`)
    }
  }
  const stopSweeper = sweep === undefined
    ? undefined
    : startSweeper({ ...sweep, store: () => store, warn: message => ctx.logger.warn(message) })
  return async () => {
    await stopSweeper?.()
    gateway.detachStore()
    await store.close()
  }
}
export * from './preset.ts'
export { loadBuiltins, resolveAgentSkills, type BuiltinSkill } from './skills/resolve.ts'
