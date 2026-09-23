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
 * @module @deepseek-ai/dsh-experimental-agents-api
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

/** Cordis plugin name. */
export const name = 'agents-api'

/** Host services required before routes can register. */
export const inject = ['webServer', 'sessions', 'agents', 'agentDefaultModel', 'tools']

/** Plugin configuration. Omitted backends stay off; env fills them in. */
export interface Config extends RuntimeConfigInput {
  /** Bearer token required in Authorization; empty string disables auth. */
  apiKey?: string
  /** API path prefix (default `/v1`). */
  prefix?: string
}

/** Validate and default plugin configuration. */
export const Config: z<Config> = z.object({
  apiKey: z.string().default(''),
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
})

/**
 * Register the Agents API prefix route and Session-event bridge.
 * @param ctx - plugin context with `webServer`, `sessions`, `agents`, `agentDefaultModel`, and `tools`.
 * @param config - optional API key and path prefix.
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
  const gateway = new AgentsGateway(ctx, config.apiKey ?? '', prefix, agentStore, sessionRegistry, {
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
