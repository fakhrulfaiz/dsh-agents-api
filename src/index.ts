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
import { AgentStore } from './agent-store.ts'
import type { Authenticator } from './auth/authenticator.ts'
import { createKeycloakAuthenticator } from './auth/keycloak.ts'
import { createStaticKeyAuthenticator } from './auth/static-key.ts'
import { bridgeChildSessionEvent, bridgeSessionEvent } from './bridge.ts'
import { CodeboxClient } from './codebox-client.ts'
import { FsAgentsApiStore, FsEnvironmentApiStore } from './durable-store.ts'
import { EnvironmentDirectory } from './environment-service.ts'
import { AgentsGateway } from './gateway.ts'
import { resolveRuntimeConfig, type RuntimeConfigInput } from './runtime-config.ts'
import { SessionRegistry } from './session-registry.ts'

export * from './types.ts'
export * from './sse.ts'
export * from './agent-store.ts'
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
export * from './durable-store.ts'
export * from './artifacts.ts'
export { bearerToken, ownerId, requireRole, unauthenticated } from './auth/authenticator.ts'
export type { AuthResult, Authenticator, OwnerId, Principal, Role as AuthRole } from './auth/authenticator.ts'
export { createKeycloakAuthenticator } from './auth/keycloak.ts'
export { createStaticKeyAuthenticator } from './auth/static-key.ts'

/** Cordis plugin name. */
export const name = 'agents-api'

/** Host services required before routes can register. */
export const inject = ['webServer', 'sessions', 'agents', 'agentDefaultModel', 'tools']

/** Authentication settings. */
export interface AuthConfig {
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

/** Plugin configuration. Omitted backends stay off; env fills them in. */
export interface Config extends RuntimeConfigInput {
  /** Authentication. Required: `production` verifies Keycloak tokens, `development` accepts a fixed key. */
  auth?: AuthConfig
  /** API path prefix (default `/v1`). */
  prefix?: string
}

/** Schemastery types `.default` as the object's value; `null` is how an optional nested object is left absent at runtime. */
const ABSENT = null as never

/** Validate and default plugin configuration. */
export const Config: z<Config> = z.transform(z.object({
  auth: z.object({
    mode: z.union([z.const('production'), z.const('development')]).required(),
    keycloak: z.object({
      issuer: z.string().required(),
      audience: z.string().required(),
      jwksTtlSeconds: z.number().default(600),
    }).default(ABSENT),
    devKey: z.object({
      key: z.string().required(),
      owner: z.string().required(),
      admin: z.boolean().default(true),
    }).default(ABSENT),
  }).default(ABSENT),
  prefix: z.string().default('/v1'),
  dataDir: z.string(),
  workspaces: z.string(),
  codebox: z.object({
    baseUrl: z.string(),
    apiKey: z.string(),
    image: z.string(),
    readyTimeoutSeconds: z.number(),
    budgetInstanceId: z.string(),
  }),
  artifacts: z.object({
    endpoint: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    region: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
  }),
}), (config) => {
  createAuthenticator(config.auth as AuthConfig | undefined)
  return config
}) as unknown as z<Config>

/**
 * Build the request authenticator from the `auth` config block.
 * @param auth - validated `auth` block.
 * @returns a Keycloak authenticator, or a static-key authenticator in development with a `devKey`.
 * @throws when `auth` is missing, `production` lacks `keycloak` or sets `devKey`, or `development` has neither.
 */
export function createAuthenticator(auth: AuthConfig | undefined): Authenticator {
  if (auth === undefined) throw new Error('agents-api: "auth" is required (set auth.mode to production or development)')
  const { mode, keycloak, devKey } = auth
  if (mode === 'production') {
    if (devKey !== undefined) throw new Error('agents-api: auth.devKey is not allowed when auth.mode is "production"')
    if (keycloak === undefined) throw new Error('agents-api: auth.keycloak is required when auth.mode is "production"')
  } else if (devKey === undefined && keycloak === undefined) {
    throw new Error('agents-api: auth.mode "development" needs auth.devKey or auth.keycloak')
  }
  if (devKey !== undefined) {
    if (!devKey.key) throw new Error('agents-api: auth.devKey.key must not be empty')
    return createStaticKeyAuthenticator({ key: devKey.key, owner: devKey.owner, admin: devKey.admin ?? true })
  }
  const kc = keycloak!
  return createKeycloakAuthenticator({ issuer: kc.issuer, audience: kc.audience, jwksTtlSeconds: kc.jwksTtlSeconds ?? 600 })
}

/**
 * Register the Agents API prefix route and Session-event bridge.
 * @param ctx - plugin context with `webServer`, `sessions`, `agents`, `agentDefaultModel`, and `tools`.
 * @param config - `auth` block and path prefix.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const prefix = config.prefix ?? '/v1'
  const runtime = resolveRuntimeConfig(config)
  const agentStore = new AgentStore()
  const sessionRegistry = new SessionRegistry()
  const environments = new EnvironmentDirectory(
    runtime.codebox === undefined ? undefined : new CodeboxClient(runtime.codebox),
    runtime.codebox ?? {},
    runtime.workspacesRoot,
  )
  const gateway = new AgentsGateway(ctx, createAuthenticator(config.auth), prefix, agentStore, sessionRegistry, {
    environments,
    ...(runtime.workspacesRoot === undefined ? {} : { workspacesRoot: runtime.workspacesRoot }),
    ...(runtime.artifacts === undefined ? {} : { artifacts: runtime.artifacts }),
  })
  if (runtime.dataDir !== undefined) {
    gateway.ready = false
    const dataDir = runtime.dataDir
    void openDataDir(dataDir, agentStore, environments).then(() => {
      gateway.ready = true
    }, (error: unknown) => {
      gateway.startError = error instanceof Error ? error.message : String(error)
    })
  }

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
 * Load agents and environments before routes answer.
 * @param dataDir - directory from config or `AGENTS_API_DATA_DIR`.
 * @param agentStore - in-memory agent directory.
 * @param environments - in-memory environment directory.
 */
async function openDataDir(
  dataDir: string,
  agentStore: AgentStore,
  environments: EnvironmentDirectory,
): Promise<void> {
  const agents = new FsAgentsApiStore(dataDir)
  const envs = new FsEnvironmentApiStore(dataDir)
  await agents.open()
  agentStore.load(await agents.loadAll())
  agentStore.bindPersistence({
    put: agent => agents.putAgent(agent),
    remove: async (id) => {
      await agents.deleteAgent(id)
    },
  })
  await environments.openDisk(envs)
}
