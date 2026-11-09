import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { materializeAgent } from '../src/agent-records.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import type { CreateAgentParams, OAIAgent } from '../src/types.ts'
import { MemoryStore } from './support/memory-store.ts'
import { FakeSessionQuery, logEvent, testGatewayOptions } from './support/fake-session-query.ts'
import { createStaticKeyAuthenticator } from '../src/auth/static-key.ts'
import { ownerId, type Authenticator } from '../src/auth/authenticator.ts'
import { openAuthenticator } from './open-auth.ts'
import { AgentsGateway } from '../src/gateway.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionRegistry } from '../src/session-registry.ts'
import { badRequest, json, notFound, readBody } from '../src/http.ts'
import { AgentsApiRequestError, SessionCreateError } from '../src/errors.ts'
import { fakeLlm, fakeModel, type FakeModel } from './support/fake-model.ts'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({
  Config: (input: Record<string, unknown>) => ({ ...input }),
  name: 'mcp-client',
}))

const servers: Server[] = []
const TEST_OWNER = ownerId('test')
const environments = createLocalProvider(join(tmpdir(), 'agentry-gateway-spec'))

async function seedAgent(store: MemoryStore, params: CreateAgentParams): Promise<OAIAgent> {
  await store.ensureOwner(TEST_OWNER)
  return store.agents.create(TEST_OWNER, materializeAgent(params))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

interface FakeAgent {
  id: string
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  model: FakeModel
}

function fakeContext(options?: {
  failCreate?: boolean
  failFollowup?: boolean
  failDispose?: boolean
  omitSystemPrompt?: boolean
}): {
  ctx: Context
  agents: Map<string, FakeAgent>
  registeredTools: Array<{ name: string; execute: (args: unknown, exec: { callId: string; signal: AbortSignal }) => Promise<unknown> }>
  restrictCalls: Array<{ allow?: readonly string[]; deny?: readonly string[] }>
  promptSections: Array<{ name: string; order: number; text: string }>
  pluginCalls: Array<Record<string, unknown>>
} {
  const agents = new Map<string, FakeAgent>()
  const sessions = new Map<string, { id: string }>()
  const registeredTools: Array<{ name: string; execute: (args: unknown, exec: { callId: string; signal: AbortSignal }) => Promise<unknown> }> = []
  const restrictCalls: Array<{ allow?: readonly string[]; deny?: readonly string[] }> = []
  const promptSections: Array<{ name: string; order: number; text: string }> = []
  const pluginCalls: Array<Record<string, unknown>> = []
  const ctx = {
    agents: {
      create: async ({
        sessionId,
        setup,
      }: {
        sessionId: string
        setup?: (agentCtx: {
          get: (name: string) => unknown
          systemPrompt?: { section: (section: { name: string; order: number; text: string }) => void }
          plugin: (plugin: unknown, config: Record<string, unknown>) => Promise<void>
          tools: {
            register: (definition: { name: string; execute: (args: unknown, exec: { callId: string; signal: AbortSignal }) => Promise<unknown> }) => () => void
            restrict: (filter: { allow?: readonly string[]; deny?: readonly string[] }) => () => void
            guard: (fn: (exec: { name: string }) => string | undefined) => () => void
          }
        }) => void | Promise<void>
      }) => {
        if (options?.failCreate) throw new Error('factory failed')
        const agent: FakeAgent = {
          id: sessionId,
          followup: vi.fn(() => {
            if (options?.failFollowup) throw 'followup failed'
          }),
          steer: vi.fn(),
          cancel: vi.fn(),
          model: fakeModel(),
        }
        agents.set(sessionId, agent)
        sessions.set(sessionId, { id: sessionId })
        if (setup) {
          const systemPrompt = options?.omitSystemPrompt
            ? undefined
            : {
                section: (section: { name: string; order: number; text: string }) => {
                  promptSections.push(section)
                },
              }
          await setup({
            get: (name: string) => name === 'systemPrompt' ? systemPrompt : undefined,
            ...(systemPrompt === undefined ? {} : { systemPrompt }),
            plugin: async (_plugin, config) => {
              pluginCalls.push(config)
            },
            tools: {
              register: (definition) => {
                registeredTools.push(definition)
                return () => undefined
              },
              restrict: (filter) => {
                if (filter.deny?.includes('missing_host_tool') || filter.allow?.includes('missing_host_tool')) {
                  throw new Error('tools.restrict() names unknown global tool "missing_host_tool"; known global tools: web_search, web_fetch')
                }
                restrictCalls.push(filter)
                return () => undefined
              },
              guard: () => () => undefined,
            },
          })
        }
        return {
          agent,
          dispose: vi.fn(async () => {
            if (options?.failDispose) throw new Error('already gone')
          }),
        }
      },
      get: (id: string) => agents.get(id),
    },
    sessions: {
      get: (id: string) => sessions.get(id),
    },
    llm: fakeLlm(),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    tools: {
      schemas: () => [
        { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: {} } },
        { name: 'web_fetch', description: 'Fetch a URL', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
      ],
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    },
  } as unknown as Context
  return { ctx, agents, registeredTools, restrictCalls, promptSections, pluginCalls }
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<string> {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

function gateway(apiKey = '', options?: {
  failCreate?: boolean
  failFollowup?: boolean
  failDispose?: boolean
  omitSystemPrompt?: boolean
}): {
  base: Promise<string>
  api: AgentsGateway
  query: FakeSessionQuery
  /** Log `event` for `sessionId` and project it, as a live `session/event` does. */
  feed: (sessionId: string, event: SessionEvent) => void
  store: MemoryStore
  registry: SessionRegistry
  agents: Map<string, FakeAgent>
  registeredTools: Array<{ name: string; execute: (args: unknown, exec: { callId: string; signal: AbortSignal }) => Promise<unknown> }>
  restrictCalls: Array<{ allow?: readonly string[]; deny?: readonly string[] }>
  promptSections: Array<{ name: string; order: number; text: string }>
  pluginCalls: Array<Record<string, unknown>>
} {
  const { ctx, agents, registeredTools, restrictCalls, promptSections, pluginCalls } = fakeContext(options)
  const store = new MemoryStore()
  const registry = new SessionRegistry()
  const query = new FakeSessionQuery()
  const api = new AgentsGateway(ctx, apiKey ? createStaticKeyAuthenticator({ key: apiKey, owner: 'test', admin: true }) : openAuthenticator, '/v1', store, registry, testGatewayOptions(environments, query))
  return {
    base: listen((req, res) => api.handle(req, res)),
    api,
    query,
    feed: (sessionId, event) => {
      query.append(sessionId, event)
      api.applySessionEvent(sessionId, event)
    },
    store,
    registry,
    agents,
    registeredTools,
    restrictCalls,
    promptSections,
    pluginCalls,
  }
}

describe('http body helpers', () => {
  it('parses objects and treats invalid JSON as empty', async () => {
    const base = await listen(async (req, res) => {
      const body = await readBody(req)
      json(res, 200, body)
    })
    expect(await (await fetch(base, { method: 'POST', body: '{"a":1}' })).json()).toEqual({ a: 1 })
    expect(await (await fetch(base, { method: 'POST', body: '[1]' })).json()).toEqual({})
    expect(await (await fetch(base, { method: 'POST', body: '{' })).json()).toEqual({})
    expect(await (await fetch(base, { method: 'POST', body: '  ' })).json()).toEqual({})
  })

  it('writes OpenAI-shaped errors', async () => {
    const base = await listen(async (req, res) => {
      if (req.url === '/missing') notFound(res, 'gone')
      else badRequest(res, 'bad')
    })
    expect((await fetch(`${base}/missing`)).status).toBe(404)
    expect((await fetch(base)).status).toBe(400)
  })
})

describe('AgentsGateway', () => {
  it('rejects a missing bearer token with a WWW-Authenticate challenge', async () => {
    const base = await gateway('secret').base
    const denied = await fetch(`${base}/v1/agents`)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('www-authenticate')).toBe('Bearer')
    expect(await denied.json()).toMatchObject({ error: { code: 'unauthenticated' } })
    expect((await fetch(`${base}/v1/agents`, { headers: { authorization: 'Bearer secret' } })).status).toBe(200)
  })

  it('answers 403 forbidden when the principal holds neither agentry role', async () => {
    const { ctx } = fakeContext()
    const noRoles = { authenticate: () => Promise.resolve({ ok: true as const, principal: { owner: ownerId('x'), roles: new Set<never>() } }) }
    const api = new AgentsGateway(ctx, noRoles, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(environments))
    const base = await listen((req, res) => api.handle(req, res))
    const denied = await fetch(`${base}/v1/agents`)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'forbidden' } })
  })

  it('covers saved-agent CRUD and refuses a missing model', async () => {
    const { base, store } = gateway()
    const root = await base
    expect((await fetch(`${root}/v1/agents`, { method: 'POST', body: '{}' })).status).toBe(400)
    const created = await (await fetch(`${root}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', name: 'coder', reasoning: { effort: 'low' } }),
    })).json() as { id: string; name: string }
    expect(created.name).toBe('coder')
    expect((await fetch(`${root}/v1/agents/${created.id}`)).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/missing`)).status).toBe(404)
    const updated = await (await fetch(`${root}/v1/agents/${created.id}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'reviewer' }),
    })).json() as { name: string }
    expect(updated.name).toBe('reviewer')
    expect((await fetch(`${root}/v1/agents/missing`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${root}/v1/agents`)).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/${created.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await store.agents.get(TEST_OWNER, created.id)).toBeUndefined()
    expect((await fetch(`${root}/v1/agents/missing`, { method: 'DELETE' })).status).toBe(404)
  })

  it('creates sessions from inline agent, agent_id, and overrides', async () => {
    const { base, store, agents } = gateway()
    const root = await base
    expect((await fetch(`${root}/v1/agents/sessions`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { instructions: 'x' } }),
    })).status).toBe(400)
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'missing' }),
    })).status).toBe(404)

    const saved = await seedAgent(store, { model: 'deepseek-chat', instructions: 'saved' })
    const fromId = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: saved.id,
        agent: { instructions: 'override' },
        environment: { type: 'none' },
        input: 'hello',
      }),
    })).json() as { id: string; agent: { instructions: string } }
    expect(fromId.agent.instructions).toBe('override')
    expect(agents.get(fromId.id)?.followup).toHaveBeenCalledOnce()

    const fromInline = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: { model: 'deepseek-chat' },
        environment: { type: 'self_hosted', workspace_directory: join(tmpdir(), 'dsh-agents-cwd') },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'list files' }] }],
      }),
    })).json() as { id: string }
    expect(fromInline.id.startsWith('sess_')).toBe(true)
    expect((await fetch(`${root}/v1/agents/sessions/${fromInline.id}`)).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/sessions`)).status).toBe(200)
  })

  it('leaves the session unchanged and answers 503 when the store write fails on update', async () => {
    const store = new MemoryStore()
    const update = vi.spyOn(store.sessions, 'update').mockRejectedValueOnce(new Error('connection refused'))
    const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', store, new SessionRegistry(), testGatewayOptions(environments))
    const root = await listen((req, res) => api.handle(req, res))
    const created = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, environment: { type: 'none' } }),
    })).json() as { id: string; agent: { model: string }; metadata: Record<string, string> }
    const failed = await fetch(`${root}/v1/agents/sessions/${created.id}`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-reasoner' }, metadata: { k: 'v' } }),
    })
    expect(failed.status).toBe(503)
    expect(update).toHaveBeenCalledOnce()
    const view = await (await fetch(`${root}/v1/agents/sessions/${created.id}`)).json() as { agent: { model: string }; metadata: Record<string, string> }
    expect(view.agent.model).toBe('deepseek-chat')
    expect(view.metadata).toEqual(created.metadata)
  })

  it('rejects a relative self-hosted workspace and a factory failure', async () => {
    const ok = gateway()
    const root = await ok.base
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: { model: 'deepseek-chat' },
        environment: { type: 'self_hosted', workspace_directory: 'relative' },
      }),
    })).status).toBe(400)

    const failing = gateway('', { failCreate: true })
    const failRoot = await failing.base
    expect((await fetch(`${failRoot}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })).status).toBe(500)
  })

  it('streams create-session events and later input, cancel, and tool output', async () => {
    const { base, agents, registry, feed } = gateway()
    const root = await base
    const stream = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'go', stream: true }),
    })
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const reader = stream.body!.getReader()
    await reader.read()
    await reader.cancel()

    const idle = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })).json() as { id: string }
    const sessionId = idle.id
    feed(sessionId, logEvent('turn/start', { turn: 1 }, 1))
    expect(registry.getOAISession(sessionId)?.status).toBe('in_progress')

    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [{
          type: 'agent.session.input.message',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'steer me' }] }],
        }],
      }),
    })).status).toBe(200)
    expect(agents.get(sessionId)?.steer).toHaveBeenCalledOnce()

    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [{ type: 'agent.session.input.function_call_output', call_id: 'c1', output: { ok: true } }],
      }),
    })).status).toBe(400)

    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}/events`, {
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'agent.session.input.cancel' }] }),
    })).status).toBe(200)
    expect(agents.get(sessionId)?.cancel).toHaveBeenCalledOnce()

    const live = await fetch(`${root}/v1/agents/sessions/${sessionId}/events?stream=true`)
    expect(live.headers.get('content-type')).toContain('text/event-stream')
    await live.body!.cancel()

    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-v4-flash', service_tier: 'flex' } }),
    })).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: '' } }),
    })).status).toBe(400)
    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: null } }),
    })).status).toBe(400)

    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}/items`)).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}/turns`)).status).toBe(200)
    const turnId = ((await (await fetch(`${root}/v1/agents/sessions/${sessionId}/turns`)).json()) as { data: Array<{ id: string }> }).data[0]?.id
    expect(turnId).toBe('turn_1')
    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}/turns/${turnId}`)).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}/turns/missing`)).status).toBe(404)

    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}`, { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/sessions/${sessionId}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('returns 404 for unknown session subresources and methods', async () => {
    const root = await gateway().base
    expect((await fetch(`${root}/v1/agents/sessions/missing`)).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/missing`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/missing/events`, { method: 'POST', body: '{"events":[]}' })).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/missing/events`)).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/missing/items`)).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/missing/turns`)).status).toBe(404)
    expect((await fetch(`${root}/v1/nope`)).status).toBe(404)
    expect((await fetch(`${root}/v1/agents`, { method: 'PUT' })).status).toBe(404)
  })

  it('streams an idle create-session when no input is provided', async () => {
    const { base, registry } = gateway()
    const root = await base
    const response = await fetch(`${root}/v1/agents/sessions?stream=true`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const chunks: string[] = []
    let sessionId: string | undefined
    for (let i = 0; i < 6; i++) {
      const { value, done } = await reader.read()
      if (done || value === undefined) break
      chunks.push(new TextDecoder().decode(value))
      const joined = chunks.join('')
      if (sessionId === undefined) {
        sessionId = /"id":"(sess_[^"]+)"/.exec(joined)?.[1]
        if (sessionId !== undefined) {
          registry.emitEphemeral(sessionId, {
            type: 'agent.session.idle',
            event_id: 'evt_stream',
            session: registry.getOAISession(sessionId)!,
          })
        }
      }
      if (joined.includes('evt_stream')) break
    }
    await reader.cancel()
    expect(chunks.join('')).toContain('agent.session.created')
    expect(chunks.join('')).toContain('evt_stream')
  })

  it('accepts empty and unknown input events and cancels an idle session', async () => {
    const { base, agents } = gateway()
    const root = await base
    const idle = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, metadata: { k: 'v' } }),
    })).json() as { id: string }
    expect((await fetch(`${root}/v1/agents/sessions/${idle.id}`)).status).toBe(200)
    const live = await fetch(`${root}/v1/agents/sessions/${idle.id}/events`)
    expect(live.headers.get('content-type')).toContain('text/event-stream')
    await live.body!.cancel()
    expect((await fetch(`${root}/v1/agents/sessions/${idle.id}/events`, {
      method: 'POST',
      body: JSON.stringify({ events: [] }),
    })).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/sessions/${idle.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [
          { type: 'agent.session.input.message', input: [{ role: 'user', content: [] }] },
          { type: 'agent.session.input.not_a_real_event' },
          { type: 'agent.session.input.cancel' },
        ],
      }),
    })).status).toBe(200)
    expect(agents.get(idle.id)?.followup).not.toHaveBeenCalled()
    expect(agents.get(idle.id)?.cancel).toHaveBeenCalledOnce()
    expect((await fetch(`${root}/v1/agents/sessions/${idle.id}`, {
      method: 'POST',
      body: JSON.stringify({ metadata: { n: '1' } }),
    })).status).toBe(200)
  })

  it('returns 404 for unofficial Assistants and turn-create routes', async () => {
    const root = await gateway().base
    expect((await fetch(`${root}/v1/threads`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/sess_x/turns`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/`)).status).toBe(200)
  })

  it('reports follow-up and dispose failures without dropping the HTTP mapping', async () => {
    const throwing = gateway('', { failFollowup: true })
    const throwRoot = await throwing.base
    expect((await fetch(`${throwRoot}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'go' }),
    })).status).toBe(200)
    const stream = await fetch(`${throwRoot}/v1/agents/sessions`, {
      method: 'POST',
      headers: { accept: 'text/event-stream' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'go', stream: true }),
    })
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    for (let i = 0; i < 4; i++) {
      const { value, done } = await reader.read()
      if (done || value === undefined) break
      chunks.push(new TextDecoder().decode(value))
      if (chunks.join('').includes('error')) break
    }
    await reader.cancel()
    expect(chunks.join('')).toContain('error')

    const disposing = gateway('', { failDispose: true })
    const disposeRoot = await disposing.base
    const created = await (await fetch(`${disposeRoot}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })).json() as { id: string }
    expect((await fetch(`${disposeRoot}/v1/agents/sessions/${created.id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('returns 500 when an input event cannot reach a live agent', async () => {
    const { base, agents } = gateway()
    const root = await base
    const created = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })).json() as { id: string }
    agents.delete(created.id)
    expect((await fetch(`${root}/v1/agents/sessions/${created.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }],
      }),
    })).status).toBe(500)
  })

  it('defaults missing request fields and tears down a registry-only session', async () => {
    const { ctx } = fakeContext()
    const api = new AgentsGateway(ctx, openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(environments))
    const chunks: Buffer[] = []
    const res = {
      setHeader() {},
      writeHead(_status: number, _headers?: unknown) {},
      write(chunk: string | Buffer) {
        chunks.push(Buffer.from(chunk))
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      },
    } as unknown as ServerResponse
    await api.handle({
      url: undefined,
      method: undefined,
      headers: {},
      on() { return this },
    } as unknown as IncomingMessage, res)
    expect(Buffer.concat(chunks).toString()).toContain('invalid_request_error')

    const prefixChunks: Buffer[] = []
    const prefixRes = {
      setHeader() {},
      writeHead() {},
      write(chunk: string | Buffer) {
        prefixChunks.push(Buffer.from(chunk))
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) prefixChunks.push(Buffer.from(chunk))
      },
    } as unknown as ServerResponse
    await api.handle({
      url: '/v1',
      method: 'GET',
      headers: {},
      on() { return this },
    } as unknown as IncomingMessage, prefixRes)
    expect(Buffer.concat(prefixChunks).toString()).toContain('Cannot GET /v1')

    class AcceptStreamReq extends EventEmitter {
      url = '/v1/agents/sessions'
      method = 'POST'
      headers = { accept: 'text/event-stream', host: 'localhost' }
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ agent: { model: 'deepseek-chat' } }))
      }
    }
    const streamReq = new AcceptStreamReq()
    const streamChunks: Buffer[] = []
    const streamRes = {
      setHeader() {},
      writeHead() {},
      flushHeaders() {},
      write(chunk: string | Buffer) {
        streamChunks.push(Buffer.from(chunk))
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) streamChunks.push(Buffer.from(chunk))
      },
    } as unknown as ServerResponse
    await api.handle(streamReq as unknown as IncomingMessage, streamRes)
    expect(Buffer.concat(streamChunks).toString()).toContain('agent.session.created')
    streamReq.emit('close')

    class JsonCreateReq extends EventEmitter {
      url = '/v1/agents/sessions'
      method = 'POST'
      headers = { host: 'localhost' }
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ agent: { model: 'deepseek-chat' } }))
      }
    }
    const jsonChunks: Buffer[] = []
    const jsonRes = {
      setHeader() {},
      writeHead() {},
      write(chunk: string | Buffer) {
        jsonChunks.push(Buffer.from(chunk))
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) jsonChunks.push(Buffer.from(chunk))
      },
    } as unknown as ServerResponse
    await api.handle(new JsonCreateReq() as unknown as IncomingMessage, jsonRes)
    expect(Buffer.concat(jsonChunks).toString()).toContain('agent.session')

    const { base, registry, store, agents, feed } = gateway()
    const root = await base
    const saved = await seedAgent(store, { model: 'deepseek-chat', instructions: 'saved' })
    const reused = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: saved.id,
        environment: { type: 'openai_hosted' },
      }),
    })).json() as { id: string; agent: { instructions: string } }
    expect(reused.agent.instructions).toBe('saved')

    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: { model: 'deepseek-chat' },
        environment: { type: 'self_hosted' },
      }),
    })).status).toBe(200)

    const now = new Date()
    await store.sessions.insert({
      id: 'sess_orphan', ownerId: TEST_OWNER, agentId: saved.id, environmentId: null, dshSessionId: 'sess_orphan',
      status: 'idle', lastError: null, model: 'deepseek-chat', reasoningEffort: null, body: null, createdAt: now, updatedAt: now,
    })
    expect((await fetch(`${root}/v1/agents/sessions/sess_orphan`, { method: 'DELETE' })).status).toBe(200)

    const liveId = reused.id
    feed(liveId, logEvent('turn/start', { turn: 1 }, 1))
    const live = await fetch(`${root}/v1/agents/sessions/${liveId}/events`)
    const reader = live.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('agent.session.in_progress')
    registry.emitEphemeral(liveId, {
      type: 'agent.session.failed',
      event_id: 'evt_test',
      session: registry.getOAISession(liveId)!,
    })
    const second = await reader.read()
    await reader.cancel()
    expect(new TextDecoder().decode(second.value)).toContain('agent.session.failed')

    agents.delete(liveId)
    expect((await fetch(`${root}/v1/agents/sessions/${liveId}/events`, {
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'agent.session.input.cancel' }] }),
    })).status).toBe(200)
    expect((await fetch(`${root}/v1/agents/sessions/${liveId}/events`, {
      method: 'POST',
      body: '{}',
    })).status).toBe(200)
  })

  it('mounts wire function tools and completes them via tool_result', async () => {
    const { base, registry, registeredTools, feed } = gateway()
    const root = await base
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          tools: [{ type: 'web_search' }],
        },
      }),
    })).status).toBe(400)

    const created = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          tools: [{
            type: 'function',
            name: 'get_weather',
            description: 'Weather lookup',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          }],
        },
      }),
    })).json() as { id: string }
    expect(registeredTools.map(tool => tool.name)).toEqual(['get_weather'])

    feed(created.id, logEvent('turn/start', { turn: 1 }, 1))
    const events: unknown[] = []
    registry.subscribe(created.id, (evt) => {
      events.push(evt)
    })

    const controller = new AbortController()
    const wait = registeredTools[0]!.execute(
      { city: 'SF' },
      { callId: 'call_weather', signal: controller.signal },
    )
    feed(created.id, logEvent('tool/call', { callId: 'call_weather', name: 'get_weather', arguments: '{"city":"SF"}' }, 2))
    expect(registry.getOAISession(created.id)?.status).toBe('requires_action')
    expect(registry.getOAISession(created.id)?.required_actions).toMatchObject([{
      type: 'function_call',
      call_id: 'call_weather',
      name: 'get_weather',
      turn_id: 'turn_1',
    }])
    expect(events.some(evt => (evt as { type: string }).type === 'agent.session.requires_action')).toBe(true)

    expect((await fetch(`${root}/v1/agents/sessions/${created.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [{
          type: 'agent.session.input.tool_result',
          turn_id: 'turn_1',
          call_id: 'call_weather',
          success: true,
          output: JSON.stringify({ temp: 68 }),
        }],
      }),
    })).status).toBe(200)
    await expect(wait).resolves.toBe('{"temp":68}')
    feed(created.id, logEvent('tool/result', { message: { source: { kind: 'tool', callId: 'call_weather' }, content: [{ type: 'text', text: '{"temp":68}' }] } }, 3))
    expect(registry.getOAISession(created.id)?.status).toBe('in_progress')
    expect(registry.getOAISession(created.id)?.required_actions).toEqual([])
  })

  it('accepts legacy function_call_output as a tool_result alias', async () => {
    const { base, registeredTools } = gateway()
    const root = await base
    const created = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          tools: [{ type: 'function', name: 'ping' }],
        },
      }),
    })).json() as { id: string }
    const wait = registeredTools[0]!.execute({}, {
      callId: 'call_ping',
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    expect((await fetch(`${root}/v1/agents/sessions/${created.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [{ type: 'agent.session.input.function_call_output', call_id: 'call_ping', output: 'pong' }],
      }),
    })).status).toBe(200)
    await expect(wait).resolves.toBe('pong')
  })

  it('lists Host tools and applies host_tools restrict on session create', async () => {
    const { base, restrictCalls, store } = gateway()
    const root = await base

    const catalog = await (await fetch(`${root}/v1/agents/tools`)).json() as {
      object: string
      data: Array<{ name: string; source: string }>
    }
    expect(catalog.object).toBe('list')
    expect(catalog.data.map(tool => tool.name)).toEqual(['web_search', 'web_fetch'])
    expect(catalog.data.every(tool => tool.source === 'host')).toBe(true)

    // Literal /agents/tools must not be captured as an agent id.
    expect((await fetch(`${root}/v1/agents/tools`)).status).toBe(200)

    expect((await fetch(`${root}/v1/agents`, {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-chat', host_tools: {} }),
    })).status).toBe(400)

    const saved = await (await fetch(`${root}/v1/agents`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'deepseek-chat',
        name: 'masked',
        host_tools: { deny: ['web_search'] },
      }),
    })).json() as { id: string; host_tools: { deny: string[] } }
    expect(saved.host_tools).toEqual({ deny: ['web_search'] })
    expect((await store.agents.get(TEST_OWNER, saved.id))?.host_tools).toEqual({ deny: ['web_search'] })

    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: saved.id,
        environment: { type: 'none' },
      }),
    })).status).toBe(200)
    expect(restrictCalls).toEqual([{ deny: ['web_search'] }])

    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          host_tools: { allow: ['web_fetch'], deny: ['web_search'] },
        },
        environment: { type: 'none' },
      }),
    })).status).toBe(200)
    expect(restrictCalls.at(-1)).toEqual({ allow: ['web_fetch'], deny: ['web_search'] })

    const unknown = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          host_tools: { deny: ['missing_host_tool'] },
        },
        environment: { type: 'none' },
      }),
    })
    expect(unknown.status).toBe(500)
    expect(await unknown.json()).toMatchObject({
      error: { message: expect.stringContaining('missing_host_tool') },
    })
  })

  it('mounts agent instructions onto the Host system prompt', async () => {
    const { base, promptSections } = gateway()
    const root = await base
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: { model: 'deepseek-chat', instructions: '  be brief  ' },
      }),
    })).status).toBe(200)
    expect(promptSections).toEqual([{
      name: 'agents-api:instructions',
      order: 10,
      text: 'be brief',
    }])

    promptSections.length = 0
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: { model: 'deepseek-chat', instructions: '   ' },
      }),
    })).status).toBe(200)
    expect(promptSections).toEqual([])
  })

  it('fails session create when instructions need a missing system prompt', async () => {
    const { base } = gateway('', { omitSystemPrompt: true })
    const root = await base
    const response = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: { model: 'deepseek-chat', instructions: 'be brief' },
      }),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('systemPrompt') },
    })
  })

  it('rejects unsupported MCP tools and mounts a client-supplied server', async () => {
    const { base, pluginCalls } = gateway()
    const root = await base
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          tools: [{
            type: 'mcp',
            server_label: 'docs',
            credential_id: 'cred',
            transport: { type: 'http', server_url: 'https://example.com/mcp' },
          }],
        },
      }),
    })).status).toBe(400)

    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          tools: [{
            type: 'mcp',
            server_label: 'docs',
            transport: {
              type: 'http',
              server_url: 'https://example.com/mcp',
              headers: { Authorization: 'Bearer t' },
            },
          }],
        },
      }),
    })).status).toBe(200)
    expect(pluginCalls).toEqual([expect.objectContaining({
      transport: 'streamable-http',
      serverName: 'docs',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    })])

    pluginCalls.length = 0
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          tools: [{
            type: 'mcp',
            server_label: 'local',
            required: false,
            transport: { type: 'stdio', command: 'echo', args: ['hi'] },
          }],
        },
      }),
    })).status).toBe(200)
    expect(pluginCalls[0]).toMatchObject({
      transport: 'stdio',
      serverName: 'local',
      command: 'echo',
      cwd: expect.stringContaining(join('agentry-gateway-spec-workspaces', 'test')),
      failOnStartupError: false,
    })
  })
})

describe('AgentsGateway store and owner scoping', () => {
  /** Authenticates every request as the owner named by `x-owner`. */
  const ownerHeader: Authenticator = {
    authenticate: req => Promise.resolve({
      ok: true as const,
      principal: { owner: ownerId(String(req.headers['x-owner'] ?? 'nobody')), roles: new Set(['agentry-user' as const]) },
    }),
  }

  it('store outage returns 503', async () => {
    const store = new MemoryStore()
    store.failure = new Error('connection refused')
    const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', store, new SessionRegistry(), testGatewayOptions(environments))
    const root = await listen((req, res) => api.handle(req, res))
    const response = await fetch(`${root}/v1/agents`)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { type: 'server_error', code: 'store_unavailable' } })
  })

  it('answers 503 store_unavailable until a store is attached, and with the start error after a failure', async () => {
    const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', undefined, new SessionRegistry(), testGatewayOptions(environments))
    const root = await listen((req, res) => api.handle(req, res))
    const opening = await fetch(`${root}/v1/agents`)
    expect(opening.status).toBe(503)
    expect(await opening.json()).toMatchObject({ error: { code: 'store_unavailable' } })
    api.failStore('migration 0001-initial.sql failed')
    const failed = await fetch(`${root}/v1/agents`)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: { code: 'store_unavailable', message: 'migration 0001-initial.sql failed' } })
    api.attachStore(new MemoryStore())
    expect((await fetch(`${root}/v1/agents`)).status).toBe(200)
    api.detachStore()
    expect((await fetch(`${root}/v1/agents`)).status).toBe(503)
  })

  it('records the owner on first request and hides other owners\' records as 404', async () => {
    const store = new MemoryStore()
    const api = new AgentsGateway(fakeContext().ctx, ownerHeader, '/v1', store, new SessionRegistry(), testGatewayOptions(environments))
    const root = await listen((req, res) => api.handle(req, res))
    const as = (owner: string, init: RequestInit = {}) => ({ ...init, headers: { 'x-owner': owner, ...(init.headers ?? {}) } })

    const agent = await (await fetch(`${root}/v1/agents`, as('alice', { method: 'POST', body: JSON.stringify({ model: 'deepseek-chat' }) }))).json() as { id: string }
    expect((await fetch(`${root}/v1/agents/${agent.id}`, as('bob'))).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/${agent.id}`, as('bob', { method: 'POST', body: '{"name":"x"}' }))).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/${agent.id}`, as('bob', { method: 'DELETE' }))).status).toBe(404)
    expect((await (await fetch(`${root}/v1/agents`, as('bob'))).json() as { data: unknown[] }).data).toEqual([])
    expect((await fetch(`${root}/v1/agents/sessions`, as('bob', { method: 'POST', body: JSON.stringify({ agent_id: agent.id }) }))).status).toBe(404)

    const session = await (await fetch(`${root}/v1/agents/sessions`, as('alice', { method: 'POST', body: JSON.stringify({ agent_id: agent.id }) }))).json() as { id: string }
    expect(await store.sessions.get(session.id, ownerId('alice'))).toMatchObject({ agentId: agent.id, status: 'idle', model: 'deepseek-chat' })
    expect((await fetch(`${root}/v1/agents/sessions/${session.id}`, as('alice'))).status).toBe(200)
    for (const path of ['', '/items', '/turns', '/events', '/artifacts', '/subagents']) {
      expect((await fetch(`${root}/v1/agents/sessions/${session.id}${path}`, as('bob'))).status).toBe(404)
    }
    expect((await fetch(`${root}/v1/agents/tools?session_id=${session.id}`, as('bob'))).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/${session.id}/events`, as('bob', { method: 'POST', body: '{}' }))).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/${session.id}`, as('bob', { method: 'POST', body: '{}' }))).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/sessions/${session.id}`, as('bob', { method: 'DELETE' }))).status).toBe(404)
    const bobSessions = await (await fetch(`${root}/v1/agents/sessions`, as('bob'))).json() as { data: unknown[] }
    expect(bobSessions.data).toEqual([])
    const aliceSessions = await (await fetch(`${root}/v1/agents/sessions`, as('alice'))).json() as { data: Array<{ id: string }> }
    expect(aliceSessions.data.map(row => row.id)).toEqual([session.id])

    const updated = await (await fetch(`${root}/v1/agents/sessions/${session.id}`, as('alice', {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-v4', reasoning: { effort: 'high' } } }),
    }))).json() as { agent: { model: string } }
    expect(updated.agent.model).toBe('deepseek-v4')
    expect(await store.sessions.get(session.id, 'any')).toMatchObject({ model: 'deepseek-v4', reasoningEffort: 'high' })

    const template = await (await fetch(`${root}/v1/agents/environments/templates`, as('alice', { method: 'POST', body: '{"name":"base"}' }))).json() as { id: string }
    expect((await fetch(`${root}/v1/agents/environments/templates/${template.id}`, as('bob'))).status).toBe(404)
    const env = await (await fetch(`${root}/v1/agents/environments`, as('alice', { method: 'POST', body: '{}' }))).json() as { id: string; provider_metadata: { workspace_directory: string } }
    expect(env.provider_metadata.workspace_directory).toBe(join(tmpdir(), 'agentry-gateway-spec', 'alice', env.id))
    expect((await fetch(`${root}/v1/agents/environments/${env.id}`, as('bob'))).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/environments/${env.id}/files`, as('bob'))).status).toBe(404)
    expect((await fetch(`${root}/v1/agents/environments`, as('bob', { method: 'POST', body: JSON.stringify({ template_id: template.id }) }))).status).toBe(400)

    expect((await fetch(`${root}/v1/agents/sessions/${session.id}`, as('alice', { method: 'DELETE' }))).status).toBe(200)
    expect(await store.sessions.get(session.id, 'any')).toBeUndefined()
    expect((await fetch(`${root}/v1/agents/environments/${env.id}`, as('alice', { method: 'DELETE' }))).status).toBe(200)
  })

  it('pages sessions newest first with after', async () => {
    const { base } = gateway()
    const root = await base
    const ids: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const created = await (await fetch(`${root}/v1/agents/sessions`, { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat' } }) })).json() as { id: string }
      ids.push(created.id)
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    const first = await (await fetch(`${root}/v1/agents/sessions?limit=2`)).json() as { data: Array<{ id: string }>; has_more: boolean; last_id: string }
    expect(first.data.map(row => row.id)).toEqual([ids[2], ids[1]])
    expect(first.has_more).toBe(true)
    const second = await (await fetch(`${root}/v1/agents/sessions?limit=2&after=${first.last_id}`)).json() as { data: Array<{ id: string }>; has_more: boolean }
    expect(second.data.map(row => row.id)).toEqual([ids[0]])
    expect(second.has_more).toBe(false)
  })
})

describe('AgentsGateway.createIdleSession', () => {
  it('inserts an index row for the owner and starts no turn', async () => {
    const { api, store, agents, registry } = gateway()
    await store.ensureOwner(TEST_OWNER)
    const session = await api.createIdleSession(TEST_OWNER, { agent: { model: 'deepseek-chat' }, metadata: { title: 'Daily', source: 'schedule' } })
    expect(session).toMatchObject({ status: 'idle', metadata: { title: 'Daily', source: 'schedule' } })
    expect(await store.sessions.get(session.id, TEST_OWNER)).toMatchObject({ ownerId: TEST_OWNER, status: 'idle', model: 'deepseek-chat' })
    expect(registry.get(session.id)).toBeDefined()
    const agent = agents.get(session.id)!
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('throws request errors for an unknown agent_id and a missing agent', async () => {
    const { api, store } = gateway()
    await store.ensureOwner(TEST_OWNER)
    await expect(api.createIdleSession(TEST_OWNER, { agent_id: 'missing' })).rejects.toMatchObject({ status: 404, code: 'resource_not_found' })
    await expect(api.createIdleSession(TEST_OWNER, {})).rejects.toBeInstanceOf(AgentsApiRequestError)
  })

  it('rolls back the registration and writes no row when agents.create fails', async () => {
    const { api, store, registry } = gateway('', { failCreate: true })
    await store.ensureOwner(TEST_OWNER)
    const register = vi.spyOn(registry, 'register')
    await expect(api.createIdleSession(TEST_OWNER, { agent: { model: 'deepseek-chat' } })).rejects.toBeInstanceOf(SessionCreateError)
    const sessionId = register.mock.calls[0]![0].snapshot().id
    expect(registry.get(sessionId)).toBeUndefined()
    expect((await store.sessions.list({ owner: TEST_OWNER, limit: 10 })).data).toEqual([])
  })
})
