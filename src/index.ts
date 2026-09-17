/**
 * OpenAI Agents API REST gateway for DeepSeek Harness.
 *
 * Official `OpenAI-Beta: agents=v1` routes implemented:
 * - Agents: `POST|GET /v1/agents`, `GET|POST|DELETE /v1/agents/{agent_id}`
 * - Sessions: `POST|GET /v1/agents/sessions`, `GET|POST|DELETE /v1/agents/sessions/{session_id}`
 * - Events: `POST|GET /v1/agents/sessions/{session_id}/events`
 * - Items: `GET /v1/agents/sessions/{session_id}/items`
 * - Turns: `GET /v1/agents/sessions/{session_id}/turns`, `GET /v1/agents/sessions/{session_id}/turns/{turn_id}`
 *
 * Reference: https://developers.openai.com/api/docs/guides/agents-api
 *
 * @module @fakhrulfaiz/dsh-agents-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentStore } from './agent-store.ts'
import { bridgeSessionEvent } from './bridge.ts'
import { AgentsGateway } from './gateway.ts'
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

/** Cordis plugin name. */
export const name = 'agents-api'

/** Host services required before routes can register. */
export const inject = ['webServer', 'sessions', 'agents', 'agentDefaultModel']

/** Plugin configuration. */
export interface Config {
  /** Bearer token required in Authorization; empty string disables auth. */
  apiKey?: string
  /** API path prefix (default `/v1`). */
  prefix?: string
}

/** Validate and default plugin configuration. */
export const Config: z<Config> = z.object({
  apiKey: z.string().default(''),
  prefix: z.string().default('/v1'),
})

/**
 * Register the Agents API prefix route and Session-event bridge.
 * @param ctx - plugin context with `webServer`, `sessions`, `agents`, and `agentDefaultModel`.
 * @param config - optional API key and path prefix.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const prefix = config.prefix ?? '/v1'
  const agentStore = new AgentStore()
  const sessionRegistry = new SessionRegistry()
  const gateway = new AgentsGateway(ctx, config.apiKey ?? '', prefix, agentStore, sessionRegistry)

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    bridgeSessionEvent(session.id, event, sessionRegistry)
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: (req: IncomingMessage, res: ServerResponse) => gateway.handle(req, res),
    }),
    `agents-api: ${prefix}`,
  )
}
