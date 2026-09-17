/**
 * HTTP dispatcher for the OpenAI Agents API.
 *
 * Route order is load-bearing: `/agents/sessions` is matched before
 * `/agents/:agent_id` so the literal `sessions` segment is never captured as
 * an agent id.
 */

import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentStore, materializeAgent } from './agent-store.ts'
import { mintEventId } from './bridge.ts'
import {
  badRequest,
  errorMessage,
  json,
  listQuery,
  matchRoute,
  normalizePath,
  notFound,
  readBody,
  routeParam,
} from './http.ts'
import { overlayAgent, userTextFromInput } from './input.ts'
import { SessionRegistry } from './session-registry.ts'
import { writeEvent, writeSSEHeaders } from './sse.ts'
import type {
  CreateAgentParams,
  CreateSessionParams,
  OAIAgent,
  OAIEnvironmentConfig,
  OAIInputEvent,
  PostSessionEventsBody,
  UpdateAgentParams,
  UpdateSessionParams,
} from './types.ts'

interface Route {
  method: string
  pattern: string
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    params: Record<string, string>,
  ) => Promise<void>
}

/** Request dispatcher registered on `ctx.webServer`. */
export class AgentsGateway {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly routes: Route[]

  /**
   * @param ctx - plugin context with `webServer`, `sessions`, and `agents`.
   * @param apiKey - required bearer token; empty string disables auth.
   * @param prefix - URL prefix, default `/v1`.
   * @param agentStore - saved-agent directory.
   * @param sessionRegistry - live session directory.
   */
  constructor(
    private readonly ctx: Context,
    private readonly apiKey: string,
    private readonly prefix: string,
    private readonly agentStore: AgentStore,
    private readonly sessionRegistry: SessionRegistry,
  ) {
    this.routes = [
      { method: 'POST', pattern: '/agents', handler: (req, res) => this.createAgent(req, res) },
      { method: 'GET', pattern: '/agents', handler: (_req, res, url) => this.listAgents(res, url) },
      { method: 'POST', pattern: '/agents/sessions', handler: (req, res, url) => this.createSession(req, res, url) },
      { method: 'GET', pattern: '/agents/sessions', handler: (_req, res, url) => this.listSessions(res, url) },
      { method: 'POST', pattern: '/agents/sessions/:session_id/events', handler: (req, res, _url, params) => this.postEvents(req, res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/events', handler: (req, res, _url, params) => this.streamEvents(req, res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/items', handler: (_req, res, url, params) => this.listItems(res, url, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/turns/:turn_id', handler: (_req, res, _url, params) => this.getTurn(res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/turns', handler: (_req, res, url, params) => this.listTurns(res, url, params) },
      { method: 'POST', pattern: '/agents/sessions/:session_id', handler: (req, res, _url, params) => this.updateSession(req, res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id', handler: (_req, res, _url, params) => this.getSession(res, params) },
      { method: 'DELETE', pattern: '/agents/sessions/:session_id', handler: (_req, res, _url, params) => this.deleteSession(res, params) },
      { method: 'GET', pattern: '/agents/:agent_id', handler: (_req, res, _url, params) => this.getAgent(res, params) },
      { method: 'POST', pattern: '/agents/:agent_id', handler: (req, res, _url, params) => this.updateAgent(req, res, params) },
      { method: 'DELETE', pattern: '/agents/:agent_id', handler: (_req, res, _url, params) => this.deleteAgent(res, params) },
    ]
  }

  /**
   * Dispatch one HTTP request under the configured prefix.
   * @param req - incoming request.
   * @param res - outgoing response.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAuth(req, res)) return
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = (req.method ?? 'GET').toUpperCase()
    const pathname = normalizePath(url.pathname)
    const subpath = pathname.startsWith(this.prefix)
      ? normalizePath(pathname.slice(this.prefix.length) || '/')
      : pathname

    for (const route of this.routes) {
      if (route.method !== method) continue
      if (!route.pattern.includes(':')) {
        if (subpath === route.pattern) {
          await route.handler(req, res, url, {})
          return
        }
        continue
      }
      const params = matchRoute(route.pattern, subpath)
      if (params) {
        await route.handler(req, res, url, params)
        return
      }
    }
    notFound(res, `Cannot ${method} ${pathname}`)
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiKey) return true
    if (req.headers.authorization === `Bearer ${this.apiKey}`) return true
    json(res, 401, {
      error: {
        type: 'authentication_error',
        message: 'Invalid API key provided',
        code: 'invalid_api_key',
      },
    })
    return false
  }

  private async createAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req) as unknown as CreateAgentParams
    if (typeof body.model !== 'string' || body.model === '') {
      badRequest(res, 'Field "model" is required')
      return
    }
    json(res, 200, this.agentStore.create(body))
  }

  private listAgents(res: ServerResponse, url: URL): Promise<void> {
    json(res, 200, this.agentStore.list(listQuery(url)))
    return Promise.resolve()
  }

  private getAgent(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const agentId = routeParam(params, 'agent_id')
    const agent = this.agentStore.get(agentId)
    if (!agent) {
      notFound(res, `Agent "${agentId}" not found`)
      return Promise.resolve()
    }
    json(res, 200, agent)
    return Promise.resolve()
  }

  private async updateAgent(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const agentId = routeParam(params, 'agent_id')
    const body = await readBody(req) as unknown as UpdateAgentParams
    const updated = this.agentStore.update(agentId, body)
    if (!updated) {
      notFound(res, `Agent "${agentId}" not found`)
      return
    }
    json(res, 200, updated)
  }

  private deleteAgent(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const agentId = routeParam(params, 'agent_id')
    if (!this.agentStore.delete(agentId)) {
      notFound(res, `Agent "${agentId}" not found`)
      return Promise.resolve()
    }
    json(res, 200, { id: agentId, object: 'agent.deleted', deleted: true })
    return Promise.resolve()
  }

  private async createSession(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await readBody(req) as unknown as CreateSessionParams
    const resolved = this.resolveSessionAgent(body, res)
    if (!resolved) return
    const cwd = this.resolveCwd(body.environment, res)
    if (cwd === undefined) return

    const sessionId = SessionId(`sess_${randomUUID().replaceAll('-', '')}`)
    try {
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: { model: resolved.model },
      })
      this.handles.set(sessionId, handle)
    } catch (error: unknown) {
      json(res, 500, {
        error: {
          type: 'server_error',
          message: errorMessage(error),
          code: 'agent_create_failed',
        },
      })
      return
    }

    const state = this.sessionRegistry.register(
      sessionId,
      resolved,
      body.environment ?? { type: 'none' },
      body.metadata ?? {},
      body.vault_ids ?? [],
    )
    const oaiSession = this.sessionRegistry.project(state)
    const stream = body.stream === true
      || url.searchParams.get('stream') === 'true'
      || (req.headers.accept ?? '').includes('text/event-stream')
    const userText = userTextFromInput(body.input)

    if (stream) {
      writeSSEHeaders(res)
      const unsubscribe = this.sessionRegistry.subscribe(sessionId, (evt) => {
        writeEvent(res, evt.type, evt)
      })
      req.on('close', () => {
        unsubscribe()
      })
      writeEvent(res, 'agent.session.created', {
        type: 'agent.session.created',
        event_id: mintEventId(),
        session: oaiSession,
      })
      if (userText !== undefined && userText !== '') {
        void this.triggerTurn(sessionId, userText).catch((error: unknown) => {
          writeEvent(res, 'error', {
            type: 'error',
            event_id: mintEventId(),
            session_id: sessionId,
            error: { message: errorMessage(error) },
          })
        })
      } else {
        writeEvent(res, 'agent.session.idle', {
          type: 'agent.session.idle',
          event_id: mintEventId(),
          session: oaiSession,
        })
      }
      return
    }

    if (userText !== undefined && userText !== '') {
      void this.triggerTurn(sessionId, userText).catch((error: unknown) => {
        this.sessionRegistry.emit(sessionId, {
          type: 'error',
          event_id: mintEventId(),
          session_id: sessionId,
          error: { message: errorMessage(error) },
        })
      })
    }
    json(res, 200, oaiSession)
  }

  private listSessions(res: ServerResponse, url: URL): Promise<void> {
    json(res, 200, this.sessionRegistry.list(listQuery(url)))
    return Promise.resolve()
  }

  private getSession(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const session = this.sessionRegistry.getOAISession(sessionId)
    if (!session) {
      notFound(res, `Session "${sessionId}" not found`)
      return Promise.resolve()
    }
    json(res, 200, session)
    return Promise.resolve()
  }

  private async updateSession(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!this.sessionRegistry.get(sessionId)) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    const body = await readBody(req) as unknown as UpdateSessionParams
    if (body.agent?.model === null || body.agent?.model === '') {
      badRequest(res, 'Field "agent.model" cannot be null or empty')
      return
    }
    json(res, 200, this.sessionRegistry.updateSession(sessionId, body))
  }

  private async deleteSession(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!this.sessionRegistry.get(sessionId)) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    this.sessionRegistry.delete(sessionId)
    const handle = this.handles.get(sessionId)
    this.handles.delete(sessionId)
    if (handle) {
      try {
        await handle.dispose()
      } catch {
        // Host teardown already ran; the Agents API session is unregistered.
      }
    }
    json(res, 200, { id: sessionId, object: 'agent.session.deleted', deleted: true })
  }

  private async postEvents(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const state = this.sessionRegistry.get(sessionId)
    if (!state || !this.ctx.sessions.get(SessionId(sessionId))) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    const body = await readBody(req) as unknown as PostSessionEventsBody
    try {
      for (const evt of body.events ?? []) {
        await this.applyInputEvent(sessionId, evt)
      }
    } catch (error: unknown) {
      json(res, 500, {
        error: {
          type: 'server_error',
          message: errorMessage(error),
          code: 'event_apply_failed',
        },
      })
      return
    }
    json(res, 200, { object: 'agent.session.events', status: 'accepted' })
  }

  private streamEvents(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const state = this.sessionRegistry.get(sessionId)
    if (!state) {
      notFound(res, `Session "${sessionId}" not found`)
      return Promise.resolve()
    }
    writeSSEHeaders(res)
    const unsubscribe = this.sessionRegistry.subscribe(sessionId, (evt) => {
      writeEvent(res, evt.type, evt)
    })
    req.on('close', () => {
      unsubscribe()
    })
    const session = this.sessionRegistry.project(state)
    const type = state.status === 'in_progress' ? 'agent.session.in_progress' : 'agent.session.idle'
    writeEvent(res, type, { type, event_id: mintEventId(), session })
    return Promise.resolve()
  }

  private listItems(res: ServerResponse, url: URL, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!this.sessionRegistry.get(sessionId)) {
      notFound(res, `Session "${sessionId}" not found`)
      return Promise.resolve()
    }
    json(res, 200, this.sessionRegistry.listItems(sessionId, listQuery(url)))
    return Promise.resolve()
  }

  private listTurns(res: ServerResponse, url: URL, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!this.sessionRegistry.get(sessionId)) {
      notFound(res, `Session "${sessionId}" not found`)
      return Promise.resolve()
    }
    json(res, 200, this.sessionRegistry.listTurns(sessionId, listQuery(url)))
    return Promise.resolve()
  }

  private getTurn(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const turnId = routeParam(params, 'turn_id')
    const turn = this.sessionRegistry.getTurn(sessionId, turnId)
    if (!turn) {
      notFound(res, `Turn "${turnId}" not found`)
      return Promise.resolve()
    }
    json(res, 200, turn)
    return Promise.resolve()
  }

  private resolveSessionAgent(body: CreateSessionParams, res: ServerResponse): OAIAgent | undefined {
    if (typeof body.agent_id === 'string' && body.agent_id !== '') {
      const saved = this.agentStore.get(body.agent_id)
      if (!saved) {
        notFound(res, `Agent "${body.agent_id}" not found`)
        return undefined
      }
      return body.agent ? overlayAgent(saved, body.agent) : saved
    }
    if (body.agent) {
      if (typeof body.agent.model !== 'string' || body.agent.model === '') {
        badRequest(res, 'Field "agent.model" is required when agent_id is omitted')
        return undefined
      }
      return materializeAgent({ ...body.agent, model: body.agent.model })
    }
    badRequest(res, 'Field "agent" or "agent_id" is required')
    return undefined
  }

  private resolveCwd(environment: OAIEnvironmentConfig | undefined, res: ServerResponse): string | undefined {
    if (environment?.type === 'self_hosted' && environment.workspace_directory) {
      if (!isAbsolute(environment.workspace_directory)) {
        badRequest(res, 'environment.workspace_directory must be an absolute path')
        return undefined
      }
      return environment.workspace_directory
    }
    return process.cwd()
  }

  private async applyInputEvent(sessionId: string, evt: OAIInputEvent): Promise<void> {
    switch (evt.type) {
      case 'agent.session.input.message': {
        const text = userTextFromInput(evt.input)
        if (text) await this.triggerTurn(SessionId(sessionId), text)
        return
      }
      case 'agent.session.input.cancel': {
        const agent = this.ctx.agents.get(SessionId(sessionId))
        agent?.cancel({ kind: 'user' }, { keepInbox: true })
        const turn = this.sessionRegistry.getCurrentTurn(sessionId)
        if (turn) {
          this.sessionRegistry.cancelTurn(sessionId, turn.id)
          this.sessionRegistry.emit(sessionId, {
            type: 'agent.session.turn.cancelled',
            event_id: mintEventId(),
            session_id: sessionId,
            turn_id: turn.id,
            turn,
          })
        }
        return
      }
      case 'agent.session.input.function_call_output': {
        const output = typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output)
        await this.triggerTurn(
          SessionId(sessionId),
          `Function output for ${evt.call_id}: ${output}`,
        )
        return
      }
      default:
        return
    }
  }

  private triggerTurn(sessionId: string, userText: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const agent = this.ctx.agents.get(SessionId(sessionId))
        if (!agent) throw new Error(`Agent "${sessionId}" is not running`)
        const message = createUserMessage({
          content: [{ type: 'text', text: userText }],
          source: { kind: 'user' },
        })
        const state = this.sessionRegistry.get(sessionId)
        if (state?.status === 'in_progress') agent.steer(message)
        else agent.followup(message)
        resolve()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      }
    })
  }
}
