/**
 * OpenAI Agents API REST gateway for DeepSeek Harness.
 *
 * Official `OpenAI-Beta: agents=v1` routes implemented:
 * - Agents: `POST|GET /v1/agents`, `GET|POST|DELETE /v1/agents/{agent_id}`
 * - Host tools catalog: `GET /v1/agents/tools`
 * - Sessions: `POST|GET /v1/agents/sessions`, `GET|POST|DELETE /v1/agents/sessions/{session_id}`
 * - Events: `POST|GET /v1/agents/sessions/{session_id}/events`
 * - Items: `GET /v1/agents/sessions/{session_id}/items`
 * - Turns: `GET /v1/agents/sessions/{session_id}/turns`, `GET /v1/agents/sessions/{session_id}/turns/{turn_id}`
 * - Environments, artifacts, and subagents under the same prefix
 * - `GET /health` on the webserver, outside `/v1`
 *
 * Reference: https://developers.openai.com/api/docs/guides/agents-api
 *
 * @module @agentry/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { firstThen, type Authenticator } from './auth/authenticator.ts'
import { createKeycloakAuthenticator } from './auth/keycloak.ts'
import { createStaticKeyAuthenticator } from './auth/static-key.ts'
import { bridgeChildSessionEvent, bridgeSessionEvent } from './bridge.ts'
import { createLocalProvider } from './environment/local.ts'
import { AgentsGateway } from './gateway.ts'
import { CodeboxDisabledError, resolveRuntimeConfig, type RuntimeConfigInput } from './runtime-config.ts'
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
export * from './store/store.ts'
export { migrate, MigrationError } from './store/migrate.ts'
export { openPostgresStore } from './store/postgres.ts'
export * from './environment/provider.ts'
export { createLocalProvider, directorySegment } from './environment/local.ts'
export { CodeboxClient, createCodeboxProvider, type CodeboxExecResult, type CodeboxProvisionSettings, type CodeboxSettings } from './environment/codebox.ts'
export { bearerToken, firstThen, ownerId, requireAnyRole, requireRole, unauthenticated } from './auth/authenticator.ts'
export type { AuthResult, Authenticator, OwnerId, Principal, Role as AuthRole } from './auth/authenticator.ts'
export { createKeycloakAuthenticator, type KeycloakAuthConfig } from './auth/keycloak.ts'
export { createStaticKeyAuthenticator } from './auth/static-key.ts'

/** Cordis plugin name. */
export const name = 'agents-api'

/** Host services required before routes can register. */
export const inject = ['webServer', 'sessions', 'agents', 'agentDefaultModel', 'tools']

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
  mode: 'production' | 'development'
  keycloak?: ResolvedKeycloakConfig
  devKey?: { key: string; owner: string; admin: boolean }
}

/** JWS algorithms accepted in `auth.keycloak.algorithms`. */
export const ALLOWED_ALGORITHMS: readonly string[] = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']

/** Plugin configuration as written in cordis.yml. Omitted backends stay off; env fills them in. */
export interface Config extends RuntimeConfigInput {
  /** Authentication. Required: `production` verifies Keycloak tokens, `development` accepts a fixed key. */
  auth?: {
    /** `production` requires `keycloak` and forbids `devKey`; `development` needs `devKey` or `keycloak`. */
    mode: 'production' | 'development'
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
    /** Fixed development bearer key. */
    devKey?: {
      key: string
      /** Owner id the key acts as. */
      owner: string
      /** Grant the `agentry-admin` role (default true). */
      admin?: boolean
    }
  }
  /** API path prefix (default `/v1`). */
  prefix?: string
  /** Agentry's Postgres database. Required. */
  database?: {
    /** Connection URL, for example `postgres://agentry:…@postgres:5432/agentry`. */
    url: string
  }
  /** Rejected with `CodeboxDisabledError`: Codebox environments are parked. */
  codebox?: unknown
  /** Rejected: removed when records moved from JSON files to Postgres (`database.url`). */
  dataDir?: unknown
}

/** `Config` after validation: `auth`, `prefix`, and `database` are always present; `codebox` and `dataDir` never are. */
export type ResolvedConfig = Omit<Config, 'auth' | 'prefix' | 'database' | 'codebox' | 'dataDir'> & {
  auth: ResolvedAuthConfig
  prefix: string
  database: { url: string }
}

/** Schemastery types `.default` as the object's value; `null` is how an optional nested object is left absent at runtime. */
const ABSENT = null as never

/** Validate and default plugin configuration. */
export const Config: z<Config, ResolvedConfig> = z.transform(z.object({
  auth: z.object({
    mode: z.union([z.const('production'), z.const('development')]).required(),
    keycloak: z.object({
      issuer: z.string().required(),
      audience: z.string().required(),
      jwksTtlSeconds: z.number().default(600),
      jwksCooldownSeconds: z.number().default(30),
      algorithms: z.array(z.string()).default(['RS256']),
      clockToleranceSeconds: z.number().default(5),
    }).default(ABSENT),
    devKey: z.object({
      key: z.string().required(),
      owner: z.string().required(),
      admin: z.boolean().default(true),
    }).default(ABSENT),
  }).default(ABSENT),
  prefix: z.string().default('/v1'),
  database: z.object({
    url: z.string().required(),
  }).required(),
  // Declared only so the transform can reject them by name.
  dataDir: z.any(),
  codebox: z.any(),
  workspaces: z.string(),
  artifacts: z.object({
    endpoint: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    region: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
  }).default(ABSENT),
}), (config) => {
  validateAuth(config.auth as ResolvedAuthConfig | undefined)
  if (config.codebox !== undefined && config.codebox !== null) throw new CodeboxDisabledError('the "codebox" config block')
  if (config.dataDir !== undefined && config.dataDir !== null) {
    throw new Error('agents-api: "dataDir" was removed; agents, environments, and the session index live in Postgres (database.url)')
  }
  return config
}, true) as unknown as z<Config, ResolvedConfig>

/**
 * Check the `auth` block for contradictory or missing settings.
 * @param auth - validated `auth` block.
 * @throws when `auth` is missing, `keycloak.algorithms` is empty or names an unsupported algorithm, `production` lacks `keycloak` or sets `devKey`, `development` has neither, or `devKey.key` is empty.
 */
export function validateAuth(auth: ResolvedAuthConfig | undefined): void {
  if (auth === undefined) throw new Error('agents-api: "auth" is required (set auth.mode to production or development)')
  const { mode, keycloak, devKey } = auth
  if (mode === 'production') {
    if (devKey !== undefined) throw new Error('agents-api: auth.devKey is not allowed when auth.mode is "production"')
    if (keycloak === undefined) throw new Error('agents-api: auth.keycloak is required when auth.mode is "production"')
  } else if (devKey === undefined && keycloak === undefined) {
    throw new Error('agents-api: auth.mode "development" needs auth.devKey or auth.keycloak')
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
 * @returns Keycloak, the static dev key, or the dev key first and Keycloak as fallback when development sets both.
 */
export function createAuthenticator(auth: ResolvedAuthConfig, warn: (message: string) => void): Authenticator {
  validateAuth(auth)
  const { keycloak, devKey } = auth
  const staticKey = devKey === undefined ? undefined : createStaticKeyAuthenticator(devKey)
  const verifier = keycloak === undefined ? undefined : createKeycloakAuthenticator({ ...keycloak, warn })
  if (staticKey !== undefined && verifier !== undefined) return firstThen(staticKey, verifier)
  return (staticKey ?? verifier)!
}

/**
 * Register the Agents API prefix route and Session-event bridge, then migrate
 * and open the Postgres store in the background. Until the store is open
 * `/v1` answers 503 `store_unavailable`; when migration or connection fails,
 * a `StoreStartError` is logged and `/v1` keeps answering 503 with its message.
 * @param ctx - plugin context with `webServer`, `sessions`, `agents`, `agentDefaultModel`, and `tools`.
 * @param config - validated config.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const prefix = config.prefix
  const runtime = resolveRuntimeConfig(config)
  const sessionRegistry = new SessionRegistry()
  const gateway = new AgentsGateway(ctx, createAuthenticator(config.auth, message => ctx.logger.warn(message)), prefix, undefined, sessionRegistry, {
    environments: createLocalProvider(runtime.environmentsRoot),
    ...(runtime.workspacesRoot === undefined ? {} : { workspacesRoot: runtime.workspacesRoot }),
    ...(runtime.artifacts === undefined ? {} : { artifacts: runtime.artifacts }),
  })

  ctx.effect(() => openStore(ctx, config.database.url, gateway), 'agents-api: postgres store')

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const parent = session.header?.parentSession
    if (session.header?.origin === 'subagent' && parent && sessionRegistry.get(parent)) {
      bridgeChildSessionEvent(parent, session.id, event, sessionRegistry)
      return
    }
    bridgeSessionEvent(session.id, event, sessionRegistry)
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
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, service: 'agents-api' }))
      },
    }),
    'agents-api: /health',
  )

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
 * Migrate, open, and attach the store; the returned disposer detaches and closes it.
 * @param ctx - plugin context, for logging.
 * @param url - Postgres connection URL.
 * @param gateway - gateway that serves from the store.
 * @returns the effect disposer.
 * @throws StoreStartError after recording it on the gateway and logging it.
 */
async function openStore(ctx: Context, url: string, gateway: AgentsGateway): Promise<() => Promise<void>> {
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
  gateway.attachStore(store)
  return async () => {
    gateway.detachStore()
    await store.close()
  }
}
