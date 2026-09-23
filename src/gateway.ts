/**
 * HTTP dispatcher for the OpenAI Agents API.
 *
 * Route order is load-bearing: `/agents/sessions` and `/agents/tools` are
 * matched before `/agents/:agent_id` so those literal segments are never
 * captured as an agent id.
 */

import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentStore, materializeAgent } from './agent-store.ts'
import { mintEventId } from './bridge.ts'
import { AgentsApiRequestError } from './errors.ts'
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
import { applyHostToolsRestrict, validateHostTools } from './host-tools.ts'
import { mountAgentInstructions } from './mount-instructions.ts'
import { mountFunctionTools, validateMountableTools } from './mount-function-tools.ts'
import { AgentsApiMcpConfigError, mcpToolsFrom, mountMcpTools } from './mount-mcp-tools.ts'
import { PendingFunctionCalls } from './pending-function-calls.ts'
import { SessionRegistry } from './session-registry.ts'
import { writeEvent, writeSSEHeaders } from './sse.ts'
import type { ArtifactS3Config } from './artifacts.ts'
import { getS3Artifact, getWorkspaceArtifact, listS3Artifacts, listWorkspaceArtifacts, sanitizeRelativePath } from './artifacts.ts'
import { EnvironmentDirectory } from './environment-service.ts'
import type { EnvironmentTemplateConfig } from './environment-types.ts'
import type { SubagentState } from './session-registry.ts'
import type {
  CreateAgentParams,
  CreateSessionParams,
  OAIAgent,
  OAIEnvironmentConfig,
  OAIFunctionTool,
  OAIHostToolsConfig,
  OAIInputEvent,
  OAIToolResultInputEvent,
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

/** Optional backends wired by plugin apply. Tests omit all of them. */
export interface GatewayOptions {
  environments?: EnvironmentDirectory
  workspacesRoot?: string
  artifacts?: ArtifactS3Config
}

interface DockerSandboxService {
  create(options: { codeboxId?: string; name?: string; persist?: boolean; network?: boolean }): Promise<unknown>
}

/** Request dispatcher registered on `ctx.webServer`. */
export class AgentsGateway {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly pendingBySession = new Map<string, PendingFunctionCalls>()
  private readonly environments: EnvironmentDirectory
  private readonly workspacesRoot: string | undefined
  private readonly artifacts: ArtifactS3Config | undefined
  private readonly routes: Route[]
  /** False while the data directory is still opening. */
  ready = true
  /** Set when opening the data directory fails. Routes stay at 503. */
  startError: string | undefined

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
    options: GatewayOptions = {},
  ) {
    this.environments = options.environments ?? new EnvironmentDirectory()
    this.workspacesRoot = options.workspacesRoot
    this.artifacts = options.artifacts
    this.routes = [
      { method: 'POST', pattern: '/agents', handler: (req, res) => this.createAgent(req, res) },
      { method: 'GET', pattern: '/agents', handler: (_req, res, url) => this.listAgents(res, url) },
      { method: 'GET', pattern: '/agents/tools', handler: (_req, res, url) => this.listHostTools(res, url) },
      { method: 'POST', pattern: '/agents/environments/templates', handler: (req, res) => this.createTemplate(req, res) },
      { method: 'GET', pattern: '/agents/environments/templates', handler: (_req, res) => this.listTemplates(res) },
      { method: 'GET', pattern: '/agents/environments/templates/:template_id', handler: (_req, res, _url, params) => this.getTemplate(res, params) },
      { method: 'POST', pattern: '/agents/environments/templates/:template_id', handler: (req, res, _url, params) => this.updateTemplate(req, res, params) },
      { method: 'DELETE', pattern: '/agents/environments/templates/:template_id', handler: (_req, res, _url, params) => this.deleteTemplate(res, params) },
      { method: 'POST', pattern: '/agents/environments', handler: (req, res) => this.createEnvironment(req, res) },
      { method: 'GET', pattern: '/agents/environments', handler: (_req, res) => this.listEnvironments(res) },
      { method: 'POST', pattern: '/agents/environments/:environment_id/files', handler: (req, res, _url, params) => this.writeEnvironmentFile(req, res, params) },
      { method: 'GET', pattern: '/agents/environments/:environment_id/files/*path', handler: (_req, res, _url, params) => this.readEnvironmentFile(res, params) },
      { method: 'GET', pattern: '/agents/environments/:environment_id/files', handler: (_req, res, _url, params) => this.listEnvironmentFiles(res, params) },
      { method: 'GET', pattern: '/agents/environments/:environment_id', handler: (_req, res, _url, params) => this.getEnvironment(res, params) },
      { method: 'DELETE', pattern: '/agents/environments/:environment_id', handler: (_req, res, _url, params) => this.deleteEnvironment(res, params) },
      { method: 'POST', pattern: '/agents/sessions', handler: (req, res, url) => this.createSession(req, res, url) },
      { method: 'GET', pattern: '/agents/sessions', handler: (_req, res, url) => this.listSessions(res, url) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/artifacts/*path', handler: (_req, res, _url, params) => this.getArtifact(res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/artifacts', handler: (_req, res, _url, params) => this.listArtifacts(res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id/turns/:turn_id/items', handler: (_req, res, _url, params) => this.listSubagentTurnItems(res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id/turns/:turn_id', handler: (_req, res, _url, params) => this.getSubagentTurn(res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id/turns', handler: (_req, res, _url, params) => this.listSubagentTurns(res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id/items', handler: (_req, res, _url, params) => this.listSubagentItems(res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id', handler: (_req, res, _url, params) => this.getSubagent(res, params) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents', handler: (_req, res, _url, params) => this.listSubagents(res, params) },
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
    if (!this.ready) {
      json(res, 503, {
        error: {
          type: 'server_error',
          message: this.startError ?? 'agents store is opening',
          code: 'starting',
        },
      })
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = (req.method ?? 'GET').toUpperCase()
    const pathname = normalizePath(url.pathname)
    const subpath = pathname.startsWith(this.prefix)
      ? normalizePath(pathname.slice(this.prefix.length) || '/')
      : pathname

    for (const route of this.routes) {
      if (route.method !== method) continue
      if (!route.pattern.includes(':') && !route.pattern.includes('*')) {
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
    const toolError = validateMountableTools(body.tools ?? [])
    if (toolError) {
      badRequest(res, toolError)
      return
    }
    const hostToolsError = validateHostTools(body.host_tools)
    if (hostToolsError) {
      badRequest(res, hostToolsError)
      return
    }
    const agent = this.agentStore.create(body)
    if (!await this.flushAgents(res)) return
    json(res, 200, agent)
  }

  private listAgents(res: ServerResponse, url: URL): Promise<void> {
    json(res, 200, this.agentStore.list(listQuery(url)))
    return Promise.resolve()
  }

  private async listHostTools(res: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get('session_id')
    const schemas = await this.hostToolSchemas()
    let data = schemas.map(schema => ({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      source: 'host' as const,
    }))
    if (sessionId) {
      const state = this.sessionRegistry.get(sessionId)
      if (!state) {
        notFound(res, `Session "${sessionId}" not found`)
        return Promise.resolve()
      }
      data = maskHostCatalog(data, state.agent.host_tools)
    }
    json(res, 200, { object: 'list', data })
    return Promise.resolve()
  }

  /**
   * Schemas a new session can call.
   *
   * The web profile keeps model-facing tools on the default agent preset, so
   * the global `schemas()` view is empty. The preset's standing scope is that
   * list. Profiles without a preset roster keep the global registry.
   */
  private async hostToolSchemas(): Promise<ReturnType<Context['tools']['schemas']>> {
    const get = (this.ctx as { get?: (name: string) => unknown }).get
    if (typeof get === 'function') {
      try {
        const presets = get.call(this.ctx, 'agentPresets') as {
          standingKeyFor?: (id?: string) => Promise<unknown>
        } | undefined
        if (presets !== undefined && typeof presets.standingKeyFor === 'function') {
          const scope = await presets.standingKeyFor()
          return this.ctx.tools.schemas(scope as never)
        }
      } catch {
        // No preset roster, or the default preset did not mount.
      }
    }
    return this.ctx.tools.schemas()
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
    if (body.tools !== undefined && body.tools !== null) {
      const toolError = validateMountableTools(body.tools)
      if (toolError) {
        badRequest(res, toolError)
        return
      }
    }
    if (body.host_tools !== undefined) {
      const hostToolsError = validateHostTools(body.host_tools)
      if (hostToolsError) {
        badRequest(res, hostToolsError)
        return
      }
    }
    const updated = this.agentStore.update(agentId, body)
    if (!updated) {
      notFound(res, `Agent "${agentId}" not found`)
      return
    }
    if (!await this.flushAgents(res)) return
    json(res, 200, updated)
  }

  private async deleteAgent(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const agentId = routeParam(params, 'agent_id')
    if (!this.agentStore.delete(agentId)) {
      notFound(res, `Agent "${agentId}" not found`)
      return
    }
    if (!await this.flushAgents(res)) return
    json(res, 200, { id: agentId, object: 'agent.deleted', deleted: true })
  }

  private async createSession(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await readBody(req) as unknown as CreateSessionParams
    const resolved = this.resolveSessionAgent(body, res)
    if (!resolved) return

    const toolError = validateMountableTools(resolved.tools)
    if (toolError) {
      badRequest(res, toolError)
      return
    }
    const hostToolsError = validateHostTools(resolved.host_tools)
    if (hostToolsError) {
      badRequest(res, hostToolsError)
      return
    }

    const sessionId = SessionId(`sess_${randomUUID().replaceAll('-', '')}`)
    let cwd: string
    let environment: OAIEnvironmentConfig
    let codeboxId: string | undefined
    try {
      const workspace = await this.resolveSessionWorkspace(body.environment, sessionId)
      cwd = workspace.cwd
      environment = workspace.environment
      codeboxId = workspace.codeboxId
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
      return
    }
    const pending = new PendingFunctionCalls(sessionId, this.sessionRegistry)
    const functionTools = resolved.tools.filter(
      (tool): tool is OAIFunctionTool => tool.type === 'function',
    )

    try {
      const defaults = this.ctx.agentDefaultModel.currentSelection()
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: {
          provider: defaults.provider,
          model: resolved.model,
          ...(defaults.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: defaults.reasoningEffort }),
        },
        setup: async (agentCtx) => {
          mountAgentInstructions(agentCtx, resolved.instructions)
          applyHostToolsRestrict(agentCtx, resolved.host_tools)
          mountFunctionTools(
            agentCtx,
            functionTools,
            pending,
            () => this.sessionRegistry.getCurrentTurn(sessionId)?.id ?? 'turn_default',
          )
          await mountMcpTools(agentCtx, mcpToolsFrom(resolved.tools), cwd)
        },
      })
      this.handles.set(sessionId, handle)
      this.pendingBySession.set(sessionId, pending)
      if (codeboxId !== undefined) {
        const sandbox = this.dockerSandbox()
        if (sandbox) {
          await sandbox.create({ codeboxId, name: sessionId, persist: true, network: true })
        }
      }
    } catch (error: unknown) {
      pending.rejectAll(new Error('session create failed'))
      const created = this.handles.get(sessionId)
      this.handles.delete(sessionId)
      this.pendingBySession.delete(sessionId)
      if (created) {
        try {
          await created.dispose()
        } catch {
          // Host teardown already ran.
        }
      }
      if (error instanceof AgentsApiMcpConfigError) {
        badRequest(res, error.message)
        return
      }
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
      environment,
      body.metadata ?? {},
      body.vault_ids ?? [],
    )
    this.sessionRegistry.noteWorkspace(sessionId, cwd)
    const oaiSession = this.sessionRegistry.project(state)
    const stream = body.stream === true
      || url.searchParams.get('stream') === 'true'
      || (req.headers.accept ?? '').includes('text/event-stream')
    const userText = userTextFromInput(body.input)

    if (stream) {
      writeSSEHeaders(res)
      const unsubscribe = this.sessionRegistry.subscribe(sessionId, (evt, sseId) => {
        writeEvent(res, evt.type, evt, sseId)
      })
      req.on('close', () => {
        unsubscribe()
      })
      this.sessionRegistry.emit(sessionId, {
        type: 'agent.session.created',
        event_id: mintEventId(),
        session: oaiSession,
      })
      if (userText !== undefined && userText !== '') {
        void this.triggerTurn(sessionId, userText).catch((error: unknown) => {
          this.sessionRegistry.emit(sessionId, {
            type: 'error',
            event_id: mintEventId(),
            session_id: sessionId,
            error: { message: errorMessage(error) },
          })
        })
      } else {
        this.sessionRegistry.emit(sessionId, {
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
    this.pendingBySession.get(sessionId)?.rejectAll(new Error(`Session "${sessionId}" was deleted`))
    this.pendingBySession.delete(sessionId)
    await this.environments.deleteEnvironmentsForSession(sessionId)
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
      if (error instanceof AgentsApiRequestError) {
        json(res, error.status, {
          error: {
            type: 'invalid_request_error',
            message: error.message,
            code: error.code,
          },
        })
        return
      }
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
    const header = req.headers['last-event-id']
    const raw = Array.isArray(header) ? header[0] : header
    const lastId = raw === undefined || raw === '' ? undefined : Number(raw)
    if (lastId !== undefined) {
      for (const frame of this.sessionRegistry.replayAfter(sessionId, Number.isFinite(lastId) ? lastId : 0)) {
        writeEvent(res, frame.event.type, frame.event, frame.id)
      }
    }
    const unsubscribe = this.sessionRegistry.subscribe(sessionId, (evt, sseId) => {
      writeEvent(res, evt.type, evt, sseId)
    })
    req.on('close', () => {
      unsubscribe()
    })
    if (lastId === undefined) {
      const session = this.sessionRegistry.project(state)
      const type = state.status === 'requires_action'
        ? 'agent.session.requires_action'
        : state.status === 'in_progress'
          ? 'agent.session.in_progress'
          : 'agent.session.idle'
      this.sessionRegistry.emit(sessionId, { type, event_id: mintEventId(), session })
    }
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

  private async resolveSessionWorkspace(
    environment: OAIEnvironmentConfig | undefined,
    sessionId: string,
  ): Promise<{ cwd: string; environment: OAIEnvironmentConfig; codeboxId?: string }> {
    if (environment?.type === 'self_hosted' && environment.workspace_directory) {
      if (!isAbsolute(environment.workspace_directory)) {
        throw new Error('environment.workspace_directory must be an absolute path')
      }
      return { cwd: environment.workspace_directory, environment }
    }
    if (environment?.type === 'local') {
      if (!environment.workspace_directory || !isAbsolute(environment.workspace_directory)) {
        throw new Error('environment.workspace_directory must be an absolute path')
      }
      return { cwd: environment.workspace_directory, environment }
    }
    if (environment?.type === 'sandbox') {
      throw new Error('sandbox environments are not available')
    }
    const cwd = await this.defaultWorkspace(sessionId)
    if (environment === undefined || environment.type === 'none') {
      return { cwd, environment: { type: 'local', workspace_directory: cwd } }
    }
    return { cwd, environment }
  }

  private async defaultWorkspace(sessionId: string): Promise<string> {
    if (this.workspacesRoot === undefined) return process.cwd()
    const dir = join(this.workspacesRoot, sessionId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  private dockerSandbox(): DockerSandboxService | undefined {
    const get = (this.ctx as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    try {
      const service = get.call(this.ctx, 'dockerSandbox')
      if (service && typeof (service as DockerSandboxService).create === 'function') {
        return service as DockerSandboxService
      }
    } catch {
      return undefined
    }
    return undefined
  }

  private async flushAgents(res: ServerResponse): Promise<boolean> {
    try {
      await this.agentStore.settled()
      return true
    } catch (error: unknown) {
      json(res, 500, {
        error: {
          type: 'server_error',
          message: errorMessage(error),
          code: 'store_write_failed',
        },
      })
      return false
    }
  }

  private async applyInputEvent(sessionId: string, evt: OAIInputEvent): Promise<void> {
    switch (evt.type) {
      case 'agent.session.input.message': {
        const text = userTextFromInput(evt.input)
        if (text) await this.triggerTurn(SessionId(sessionId), text)
        return
      }
      case 'agent.session.input.cancel': {
        this.pendingBySession.get(sessionId)?.rejectAll(new Error('turn cancelled'))
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
      case 'agent.session.input.tool_result': {
        this.applyToolResult(sessionId, evt)
        return
      }
      case 'agent.session.input.function_call_output': {
        const output = typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output)
        this.applyToolResult(sessionId, {
          type: 'agent.session.input.tool_result',
          turn_id: evt.turn_id ?? this.sessionRegistry.getCurrentTurn(sessionId)?.id ?? '',
          call_id: evt.call_id,
          success: true,
          output,
        })
        return
      }
      default:
        return
    }
  }

  private applyToolResult(sessionId: string, evt: OAIToolResultInputEvent): void {
    const pending = this.pendingBySession.get(sessionId)
    if (!pending?.has(evt.call_id)) {
      throw new AgentsApiRequestError(
        `No pending function call with call_id "${evt.call_id}"`,
        400,
        'unknown_call_id',
      )
    }
    if (evt.turn_id) {
      const current = this.sessionRegistry.getCurrentTurn(sessionId)
      if (current && current.id !== evt.turn_id) {
        throw new AgentsApiRequestError(
          `turn_id "${evt.turn_id}" does not match the open turn "${current.id}"`,
          400,
          'turn_mismatch',
        )
      }
    }
    const outcome = evt.success
      ? {
        success: true as const,
        output: typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output),
      }
      : { success: false as const, error: evt.error }
    if (!pending.complete(evt.call_id, outcome)) {
      throw new AgentsApiRequestError(
        `No pending function call with call_id "${evt.call_id}"`,
        400,
        'unknown_call_id',
      )
    }
  }

  private async createTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req) as { name?: string; config?: EnvironmentTemplateConfig }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      badRequest(res, 'Field "name" is required')
      return
    }
    const template = this.environments.createTemplate({
      name: body.name,
      ...(body.config !== undefined ? { config: body.config } : {}),
    })
    await this.environments.settled()
    json(res, 201, template)
  }

  private listTemplates(res: ServerResponse): Promise<void> {
    json(res, 200, { object: 'list', data: [...this.environments.templates.values()] })
    return Promise.resolve()
  }

  private getTemplate(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const template = this.environments.templates.get(routeParam(params, 'template_id'))
    if (!template) {
      notFound(res, 'template not found')
      return Promise.resolve()
    }
    json(res, 200, template)
    return Promise.resolve()
  }

  private async updateTemplate(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const templateId = routeParam(params, 'template_id')
    if (!this.environments.templates.has(templateId)) {
      notFound(res, 'template not found')
      return
    }
    const body = await readBody(req) as { name?: string; config?: EnvironmentTemplateConfig }
    const updated = this.environments.updateTemplate(templateId, {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(body.config !== undefined ? { config: body.config } : {}),
    })
    await this.environments.settled()
    json(res, 200, updated)
  }

  private async deleteTemplate(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const templateId = routeParam(params, 'template_id')
    if (!this.environments.deleteTemplate(templateId)) {
      notFound(res, 'template not found')
      return
    }
    await this.environments.settled()
    json(res, 200, { id: templateId, object: 'environment.template.deleted', deleted: true })
  }

  private async createEnvironment(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req) as { template_id?: string; session_id?: string; image?: string }
    try {
      const env = await this.environments.createEnvironment({
        ...(typeof body.template_id === 'string' ? { template_id: body.template_id } : {}),
        ...(typeof body.session_id === 'string' ? { session_id: body.session_id } : {}),
        ...(typeof body.image === 'string' ? { image: body.image } : {}),
        provision: true,
      })
      await this.environments.settled()
      json(res, 201, env)
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
    }
  }

  private listEnvironments(res: ServerResponse): Promise<void> {
    json(res, 200, { object: 'list', data: [...this.environments.environments.values()] })
    return Promise.resolve()
  }

  private async getEnvironment(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const env = await this.environments.refreshEnvironment(routeParam(params, 'environment_id'))
    if (!env) {
      notFound(res, 'environment not found')
      return
    }
    json(res, 200, env)
  }

  private async deleteEnvironment(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const environmentId = routeParam(params, 'environment_id')
    if (!await this.environments.deleteEnvironment(environmentId)) {
      notFound(res, 'environment not found')
      return
    }
    await this.environments.settled()
    json(res, 200, { id: environmentId, object: 'environment.deleted', deleted: true })
  }

  private async writeEnvironmentFile(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const environmentId = routeParam(params, 'environment_id')
    if (!this.environments.environments.has(environmentId)) {
      notFound(res, 'environment not found')
      return
    }
    const body = await readBody(req) as { path?: string; content?: string; content_base64?: string }
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      badRequest(res, 'Field "path" is required')
      return
    }
    const content = typeof body.content === 'string'
      ? body.content
      : typeof body.content_base64 === 'string'
        ? Buffer.from(body.content_base64, 'base64')
        : undefined
    if (content === undefined) {
      badRequest(res, 'Field "content" or "content_base64" is required')
      return
    }
    try {
      await this.environments.writeFile(environmentId, body.path, content)
      json(res, 201, { object: 'environment.file', path: body.path, written: true })
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
    }
  }

  private async listEnvironmentFiles(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const environmentId = routeParam(params, 'environment_id')
    if (!this.environments.environments.has(environmentId)) {
      notFound(res, 'environment not found')
      return
    }
    try {
      const files = await this.environments.listFiles(environmentId)
      json(res, 200, { object: 'list', data: files.map(path => ({ path })) })
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
    }
  }

  private async readEnvironmentFile(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const environmentId = routeParam(params, 'environment_id')
    if (!this.environments.environments.has(environmentId)) {
      notFound(res, 'environment not found')
      return
    }
    const filePath = params['path'] ?? ''
    if (filePath.trim() === '') {
      badRequest(res, 'file path is required')
      return
    }
    try {
      const bytes = await this.environments.readFile(environmentId, filePath)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/octet-stream')
      res.end(Buffer.from(bytes))
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
    }
  }

  private async listArtifacts(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const state = this.sessionRegistry.get(sessionId)
    if (!state) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    const data = this.artifacts !== undefined
      ? await listS3Artifacts(this.artifacts, sessionId)
      : await listWorkspaceArtifacts(state.workspace ?? process.cwd())
    json(res, 200, { object: 'list', data })
  }

  private async getArtifact(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const state = this.sessionRegistry.get(sessionId)
    if (!state) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    const rawPath = params['path'] ?? ''
    if (sanitizeRelativePath(rawPath) === undefined) {
      badRequest(res, 'artifact path escapes the session workspace')
      return
    }
    const body = this.artifacts !== undefined
      ? await getS3Artifact(this.artifacts, sessionId, rawPath)
      : await getWorkspaceArtifact(state.workspace ?? process.cwd(), rawPath)
    if (body === undefined) {
      notFound(res, 'artifact not found')
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.end(body)
  }

  private listSubagents(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!this.sessionRegistry.get(sessionId)) {
      notFound(res, `Session "${sessionId}" not found`)
      return Promise.resolve()
    }
    json(res, 200, {
      object: 'list',
      data: this.sessionRegistry.listSubagents(sessionId).map(projectSubagent),
    })
    return Promise.resolve()
  }

  private getSubagent(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const subagentId = routeParam(params, 'subagent_id')
    if (!this.sessionRegistry.get(sessionId)) {
      notFound(res, `Session "${sessionId}" not found`)
      return Promise.resolve()
    }
    const child = this.sessionRegistry.getSubagent(sessionId, subagentId)
    if (!child) {
      notFound(res, 'subagent not found')
      return Promise.resolve()
    }
    json(res, 200, projectSubagent(child))
    return Promise.resolve()
  }

  private listSubagentTurns(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const located = this.requireSubagent(res, params)
    if (!located) return Promise.resolve()
    json(res, 200, { object: 'list', data: this.sessionRegistry.listChildTurns(located.sessionId, located.subagentId) ?? [] })
    return Promise.resolve()
  }

  private getSubagentTurn(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const located = this.requireSubagent(res, params)
    if (!located) return Promise.resolve()
    const turn = this.sessionRegistry.getChildTurn(located.sessionId, located.subagentId, routeParam(params, 'turn_id'))
    if (!turn) {
      notFound(res, 'turn not found')
      return Promise.resolve()
    }
    json(res, 200, turn)
    return Promise.resolve()
  }

  private listSubagentItems(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const located = this.requireSubagent(res, params)
    if (!located) return Promise.resolve()
    json(res, 200, { object: 'list', data: this.sessionRegistry.listChildItems(located.sessionId, located.subagentId) ?? [] })
    return Promise.resolve()
  }

  private listSubagentTurnItems(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const located = this.requireSubagent(res, params)
    if (!located) return Promise.resolve()
    const turnId = routeParam(params, 'turn_id')
    if (!this.sessionRegistry.getChildTurn(located.sessionId, located.subagentId, turnId)) {
      notFound(res, 'turn not found')
      return Promise.resolve()
    }
    const items = (this.sessionRegistry.listChildItems(located.sessionId, located.subagentId) ?? [])
      .filter(item => item.turn_id === turnId)
    json(res, 200, { object: 'list', data: items })
    return Promise.resolve()
  }

  private requireSubagent(
    res: ServerResponse,
    params: Record<string, string>,
  ): { sessionId: string; subagentId: string } | undefined {
    const sessionId = routeParam(params, 'session_id')
    const subagentId = routeParam(params, 'subagent_id')
    if (!this.sessionRegistry.get(sessionId)) {
      notFound(res, `Session "${sessionId}" not found`)
      return undefined
    }
    if (!this.sessionRegistry.getSubagent(sessionId, subagentId)) {
      notFound(res, 'subagent not found')
      return undefined
    }
    return { sessionId, subagentId }
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
        if (state?.status === 'in_progress' || state?.status === 'requires_action') {
          agent.steer(message)
        } else {
          agent.followup(message)
        }
        resolve()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      }
    })
  }
}

/**
 * Hide Host catalog rows outside a session's saved `host_tools` mask.
 * @param rows - full catalog.
 * @param hostTools - allow and deny lists from the session agent.
 */
function maskHostCatalog<T extends { name: string }>(
  rows: T[],
  hostTools: OAIHostToolsConfig | null | undefined,
): T[] {
  if (!hostTools) return rows
  let out = rows
  if (hostTools.allow !== undefined && hostTools.allow !== null && hostTools.allow.length > 0) {
    const allow = new Set(hostTools.allow)
    out = out.filter(row => allow.has(row.name))
  }
  if (hostTools.deny !== undefined && hostTools.deny !== null && hostTools.deny.length > 0) {
    const deny = new Set(hostTools.deny)
    out = out.filter(row => !deny.has(row.name))
  }
  return out
}

/**
 * Wire shape for a subagent. Turns and items stay on their own routes.
 * @param child - stored child.
 */
function projectSubagent(child: SubagentState): Omit<SubagentState, 'turns' | 'items' | 'currentTurnId'> {
  return {
    id: child.id,
    object: child.object,
    session_id: child.session_id,
    parent_session_id: child.parent_session_id,
    status: child.status,
    created_at: child.created_at,
    ...(child.closed_at !== undefined ? { closed_at: child.closed_at } : {}),
  }
}
