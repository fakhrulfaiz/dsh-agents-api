import { healthResponse } from '../src/index.ts'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { APP_TOOLS } from '../src/mount-composio-app-tools.ts'
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

/** Create an environment and wait for the background setup to finish (the create answers `pending`). */
async function createSettled(call: (path: string, init?: RequestInit) => Promise<Response>, body: string): Promise<{ id: string; status: string; error?: string; [key: string]: unknown }> {
  const created = (await (await call('/agents/environments', { method: 'POST', body })).json()) as { id: string; status: string }
  for (let attempt = 0; attempt < 200; attempt++) {
    const env = (await (await call(`/agents/environments/${created.id}`)).json()) as { id: string; status: string; error?: string }
    if (env.status !== 'pending') return env
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  throw new Error('environment stayed pending')
}
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
  session: { append: ReturnType<typeof vi.fn> }
}

/** Names of the agent management tools the last fake context saw mounted. */
const mountedAgentTools: string[] = []
/** Preset ids sessions mounted through `agentPresets.mount`. */
const mountedPresets: string[] = []

function fakeContext(options?: {
  /** `agents.create` waits for this before it builds the agent, like a slow MCP connection. */
  createGate?: Promise<void>
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
  mountedAgentTools.length = 0
  mountedPresets.length = 0
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
          systemPrompt?: { section: (section: { name: string; order: number; text: string }) => void; getSectionOrder: (name: string) => number }
          plugin: (plugin: unknown, config: Record<string, unknown>) => Promise<void>
          tools: {
            register: (definition: { name: string; execute: (args: unknown, exec: { callId: string; signal: AbortSignal }) => Promise<unknown> }) => () => void
            restrict: (filter: { allow?: readonly string[]; deny?: readonly string[] }) => () => void
            guard: (fn: (exec: { name: string }) => string | undefined) => () => void
          }
        }) => void | Promise<void>
      }) => {
        if (options?.createGate) await options.createGate
        if (options?.failCreate) throw new Error('factory failed')
        const agent: FakeAgent = {
          id: sessionId,
          session: { append: vi.fn() },
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
                getSectionOrder: () => 2500,
              }
          await setup({
            get: (name: string) => name === 'systemPrompt' ? systemPrompt : name === 'agentPresets' ? { mount: async (_ctx: unknown, id?: string) => { mountedPresets.push(id ?? 'agentry') } } : undefined,
            ...(systemPrompt === undefined ? {} : { systemPrompt }),
            plugin: async (_plugin, config) => {
              pluginCalls.push(config)
            },
            tools: {
              register: (definition) => {
                // The agent management tools are mounted on every session; these tests are about wire tools.
                if (definition.name.startsWith('agent_')) mountedAgentTools.push(definition.name)
                else registeredTools.push(definition)
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
  createGate?: Promise<void>
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

const APP_TOOL_NAMES = new Set(APP_TOOLS.map(tool => tool.name))

/** A create whose agent setup fails answers 200, then the session turns `failed` with a generic error. */
async function expectSetupFailed(store: MemoryStore, response: Response): Promise<void> {
  expect(response.status).toBe(200)
  const { id } = await response.json() as { id: string }
  await vi.waitFor(async () => {
    expect(await store.sessions.get(id, TEST_OWNER)).toMatchObject({ status: 'failed', lastError: 'The session could not be set up' })
  })
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

  it('keeps the browser field on saved agents and refuses a non-boolean', async () => {
    const { base } = gateway()
    const root = await base
    const bad = await fetch(`${root}/v1/agents`, { method: 'POST', body: JSON.stringify({ model: 'deepseek-chat', browser: 'yes' }) })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { message: 'browser must be a boolean or null' } })
    const created = await (await fetch(`${root}/v1/agents`, { method: 'POST', body: JSON.stringify({ model: 'deepseek-chat', browser: true }) })).json() as { id: string; browser?: boolean | null }
    expect(created.browser).toBe(true)
    expect((await fetch(`${root}/v1/agents/${created.id}`, { method: 'POST', body: JSON.stringify({ browser: 1 }) })).status).toBe(400)
    const off = await (await fetch(`${root}/v1/agents/${created.id}`, { method: 'POST', body: JSON.stringify({ browser: false }) })).json() as { browser?: boolean | null }
    expect(off.browser).toBe(false)
    const kept = await (await fetch(`${root}/v1/agents/${created.id}`, { method: 'POST', body: JSON.stringify({ name: 'n' }) })).json() as { browser?: boolean | null }
    expect(kept.browser).toBe(false)
  })

  it('refuses an inline session agent with a non-boolean browser, and never stores a browser tool', async () => {
    const { base } = gateway()
    const root = await base
    expect((await fetch(`${root}/v1/agents/sessions`, { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat', browser: 'on' } }) })).status).toBe(400)
    const session = await (await fetch(`${root}/v1/agents/sessions`, { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat', browser: true } }) })).json() as { agent: { browser?: boolean; tools: unknown[] } }
    expect(session.agent.browser).toBe(true)
    expect(session.agent.tools).toEqual([])
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

  it('rejects a relative self-hosted workspace and marks a factory failure failed', async () => {
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
    await expectSetupFailed(failing.store, await fetch(`${failRoot}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    }))
  })

  it('shows a generic message when the agent setup fails', async () => {
    const failing = gateway('', { failCreate: true })
    const response = await fetch(`${await failing.base}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })
    const { id } = await response.clone().json() as { id: string }
    await expectSetupFailed(failing.store, response)
    expect(JSON.stringify(await failing.store.sessions.get(id, TEST_OWNER))).not.toContain('factory failed')
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
      id: 'sess_orphan', ownerId: TEST_OWNER, agentId: saved.id, environmentId: null, projectId: null, dshSessionId: 'sess_orphan',
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

  it('mounts the agent management tools on a new session', async () => {
    const { base } = gateway()
    const root = await base
    expect((await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'hi' }),
    })).status).toBe(200)
    expect([...mountedAgentTools].sort()).toEqual(['agent_create', 'agent_get', 'agent_list', 'agent_tools', 'agent_update'])
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
    expect(registeredTools.map(tool => tool.name).filter(name => !name.startsWith('skill_') && !APP_TOOL_NAMES.has(name))).toEqual(['get_weather'])

    feed(created.id, logEvent('turn/start', { turn: 1 }, 1))
    const events: unknown[] = []
    registry.subscribe(created.id, (evt) => {
      events.push(evt)
    })

    const controller = new AbortController()
    const wait = registeredTools.find(tool => tool.name === 'get_weather')!.execute(
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
    const wait = registeredTools.find(tool => tool.name === 'ping')!.execute({}, {
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
    expect(restrictCalls).toEqual([{ deny: ['web_search', 'plugin_manager'] }])

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
    expect(restrictCalls.at(-1)).toEqual({ allow: ['web_fetch'], deny: ['web_search', 'plugin_manager'] })

    await expectSetupFailed(store, await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: {
          model: 'deepseek-chat',
          host_tools: { deny: ['missing_host_tool'] },
        },
        environment: { type: 'none' },
      }),
    }))
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
    expect(promptSections.filter(section => section.name === 'agents-api:instructions')).toEqual([{
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
    expect(promptSections.filter(section => section.name === 'agents-api:instructions')).toEqual([])
  })

  it('fails the session when instructions need a missing system prompt', async () => {
    const { base, store } = gateway('', { omitSystemPrompt: true })
    const root = await base
    await expectSetupFailed(store, await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent: { model: 'deepseek-chat', instructions: 'be brief' },
      }),
    }))
  })

  describe('MCP secret redaction', () => {
    const SECRET = 'ck_test_secret'
    const tools = [
      { type: 'mcp', server_label: 'composio', transport: { type: 'http', server_url: 'https://example.com/mcp', headers: { 'x-consumer-api-key': SECRET } } },
      { type: 'mcp', server_label: 'local', required: false, transport: { type: 'stdio', command: 'echo', args: ['hi'], env: { API_KEY: SECRET } } },
    ]

    it('never returns header or env values from session create, get, list, update, or SSE', async () => {
      const { base, store, pluginCalls } = gateway()
      const root = await base
      const createdResponse = await fetch(`${root}/v1/agents/sessions`, {
        method: 'POST',
        body: JSON.stringify({ agent: { model: 'deepseek-chat', tools } }),
      })
      const createdText = await createdResponse.text()
      expect(createdText).not.toContain(SECRET)
      const created = JSON.parse(createdText) as { id: string; agent: { tools: Array<{ transport: Record<string, unknown> }> } }
      expect(created.agent.tools[0]?.transport.headers).toEqual({ 'x-consumer-api-key': '***' })
      expect(created.agent.tools[1]?.transport).toMatchObject({ command: 'echo', args: ['hi'], env: { API_KEY: '***' } })

      expect(await (await fetch(`${root}/v1/agents/sessions/${created.id}`)).text()).not.toContain(SECRET)
      expect(await (await fetch(`${root}/v1/agents/sessions`)).text()).not.toContain(SECRET)
      const updated = await fetch(`${root}/v1/agents/sessions/${created.id}`, { method: 'POST', body: JSON.stringify({ metadata: { a: 'b' } }) })
      expect(await updated.text()).not.toContain(SECRET)

      // Stored config and the mounted client still hold the real values.
      expect(JSON.stringify((await store.sessions.get(created.id, TEST_OWNER))?.body)).toContain(SECRET)
      expect(pluginCalls[0]).toMatchObject({ headers: { 'x-consumer-api-key': SECRET } })
      expect(pluginCalls[1]).toMatchObject({ env: { API_KEY: SECRET } })

      const stream = await fetch(`${root}/v1/agents/sessions`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify({ agent: { model: 'deepseek-chat', tools }, stream: true }),
      })
      const reader = stream.body!.getReader()
      const first = new TextDecoder().decode((await reader.read()).value)
      await reader.cancel()
      expect(first).toContain('agent.session.created')
      expect(first).not.toContain(SECRET)
    })

    it('masks saved agents on create, get, list, and update and refuses a masked update', async () => {
      const { base, store } = gateway()
      const root = await base
      const created = await (await fetch(`${root}/v1/agents`, {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-chat', tools }),
      })).json() as { id: string }
      const responses = [
        JSON.stringify(created),
        await (await fetch(`${root}/v1/agents/${created.id}`)).text(),
        await (await fetch(`${root}/v1/agents`)).text(),
        await (await fetch(`${root}/v1/agents/${created.id}`, { method: 'POST', body: JSON.stringify({ name: 'renamed' }) })).text(),
      ]
      for (const text of responses) {
        expect(text).not.toContain(SECRET)
        expect(text).toContain('***')
      }

      const echoed = await fetch(`${root}/v1/agents/${created.id}`, {
        method: 'POST',
        body: JSON.stringify({ tools: JSON.parse(responses[1]!).tools }),
      })
      expect(echoed.status).toBe(400)
      expect(await echoed.json()).toMatchObject({ error: { code: 'bad_request' } })
      expect(JSON.stringify(await store.agents.get(TEST_OWNER, created.id))).toContain(SECRET)
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

  it('reports the store state for /health: starting, failed with the error, then ready', () => {
    const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', undefined, new SessionRegistry(), testGatewayOptions(environments))
    expect(api.storeStatus()).toEqual({ state: 'starting' })
    expect(healthResponse(api.storeStatus())).toEqual({ status: 503, body: { ok: false, service: 'agents-api', store: 'starting' } })
    api.failStore('migration 0001-initial.sql failed')
    expect(healthResponse(api.storeStatus())).toEqual({ status: 503, body: { ok: false, service: 'agents-api', store: 'failed', error: 'migration 0001-initial.sql failed' } })
    api.attachStore(new MemoryStore())
    expect(healthResponse(api.storeStatus())).toEqual({ status: 200, body: { ok: true, service: 'agents-api' } })
    api.detachStore()
    expect(api.storeStatus()).toEqual({ state: 'starting' })
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

describe('sandbox environments through the gateway', () => {
  it('creates on the sandbox provider, lists providers with availability, starts, stops, resets; local refuses lifecycle', async () => {
    const { startTestService } = await import('@agentry/sandbox/testing')
    const { createAgentrySandboxProvider } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    const { SandboxRegistry } = await import('../src/sandbox/registry.ts')
    const svc = await startTestService({ AGENTRY_SANDBOX_MAX_PER_OWNER: '1' })
    try {
      const registry = new SandboxRegistry('local')
      registry.register(createLocalProvider(join(tmpdir(), 'agentry-gateway-spec-sbx')))
      registry.register(createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: join(tmpdir(), 'agentry-gateway-spec-sbx') }))
      const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(registry))
      const base = await listen((req, res) => api.handle(req, res))
      const call = (path: string, init?: RequestInit) => fetch(`${base}/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'OpenAI-Beta': 'agents=v1' } })
      const providers = (await (await call('/agents/environments/providers')).json()) as { data: { name: string; available: boolean }[] }
      expect(providers.data.map((p) => [p.name, p.available])).toEqual(expect.arrayContaining([['local', true], ['sandbox', true]]))
      const env = (await createSettled(call, JSON.stringify({ provider: 'sandbox' }))) as { id: string; provider: string; status: string }
      expect(env).toMatchObject({ provider: 'sandbox', status: 'connected', sandbox: { state: 'running' } })
      const stopped = await call(`/agents/environments/${env.id}/stop`, { method: 'POST' })
      expect(stopped.status).toBe(200)
      expect(await stopped.json()).toMatchObject({ sandbox: { state: 'stopped' } })
      expect((await call(`/agents/environments/${env.id}/start`, { method: 'POST' })).status).toBe(200)
      expect((await call(`/agents/environments/${env.id}/reset`, { method: 'POST', body: JSON.stringify({ keep_workspace: false }) })).status).toBe(200)
      expect(svc.backend.calls.some((c) => c.endsWith('keep=false'))).toBe(true)
      const second = (await createSettled(call, JSON.stringify({ provider: 'sandbox' }))) as { status: string; error?: string }
      expect(second).toMatchObject({ status: 'failed', error: expect.stringContaining('limit 1') })
      const local = (await (await call('/agents/environments', { method: 'POST', body: JSON.stringify({ name: 'Scratch' }) })).json()) as { id: string; name?: string; sandbox?: unknown }
      expect(local.name).toBe('Scratch')
      expect(local.sandbox).toBeUndefined()
      expect((await call('/agents/environments', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(81) }) })).status).toBe(400)
      const renamed = (await (await call(`/agents/environments/${local.id}`, { method: 'POST', body: JSON.stringify({ name: ' Notes ' }) })).json()) as { name?: string }
      expect(renamed.name).toBe('Notes')
      expect(((await (await call(`/agents/environments/${local.id}`)).json()) as { name?: string }).name).toBe('Notes')
      expect(((await (await call(`/agents/environments/${local.id}`, { method: 'POST', body: JSON.stringify({ name: '' }) })).json()) as { name?: string }).name).toBeUndefined()
      expect((await call(`/agents/environments/${local.id}`, { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(81) }) })).status).toBe(400)
      expect((await call('/agents/environments/env_missing', { method: 'POST', body: JSON.stringify({ name: 'a' }) })).status).toBe(404)
      const refused = await call(`/agents/environments/${local.id}/start`, { method: 'POST' })
      expect(refused.status).toBe(409)
      expect(JSON.stringify(await refused.json())).not.toContain(svc.key)
    } finally {
      await svc.close()
    }
  })
})

describe('environment place', () => {
  const setup = async (svcUrl?: { url: string; key: string }) => {
    const { createAgentrySandboxProvider } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    const { SandboxRegistry } = await import('../src/sandbox/registry.ts')
    const registry = new SandboxRegistry('local')
    registry.register(createLocalProvider(join(tmpdir(), 'agentry-gateway-spec-place')))
    if (svcUrl) registry.register(createAgentrySandboxProvider({ url: svcUrl.url, key: svcUrl.key, workspacesRoot: join(tmpdir(), 'agentry-gateway-spec-place') }))
    const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(registry))
    const base = await listen((req, res) => api.handle(req, res))
    return (path: string, init?: RequestInit) => fetch(`${base}/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'OpenAI-Beta': 'agents=v1' } })
  }

  it('environment create forwards place to the service', async () => {
    const { startTestService } = await import('@agentry/sandbox/testing')
    const svc = await startTestService()
    try {
      const call = await setup(svc)
      const env = (await createSettled(call, JSON.stringify({ provider: 'sandbox', place: 'local' }))) as { status: string; sandbox?: { place?: string } }
      expect(env).toMatchObject({ status: 'connected', sandbox: { place: 'local' } })
      const bad = (await createSettled(call, JSON.stringify({ provider: 'sandbox', place: 'nowhere' }))) as { status: string; error?: string }
      expect(bad.status).toBe('failed')
    } finally {
      await svc.close()
    }
  })

  it('place on a non-sandbox provider is 400', async () => {
    const call = await setup()
    const res = await call('/agents/environments', { method: 'POST', body: JSON.stringify({ place: 'local' }) })
    expect(res.status).toBe(400)
  })
})

describe('sessions on Agentry Sandbox environments', () => {
  it('mount the sandbox preset (one registration per sandbox), local sessions mount agentry, deleting the environment evicts it', async () => {
    const { startTestService } = await import('@agentry/sandbox/testing')
    const { createAgentrySandboxProvider } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    const { SandboxRegistry } = await import('../src/sandbox/registry.ts')
    const { createSandboxPresets } = await import('../src/sandbox/presets.ts')
    const svc = await startTestService()
    try {
      const root = join(tmpdir(), 'agentry-gateway-spec-sbx-presets')
      const registry = new SandboxRegistry('local')
      registry.register(createLocalProvider(root))
      registry.register(createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: root }))
      const registered = new Map<string, unknown>()
      const sandboxPresets = createSandboxPresets({
        presets: () => ({ register: async (def) => { registered.set(def.id, def.plugins); return async () => { registered.delete(def.id) } } }),
        rows: () => [{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' }],
      })
      const store = new MemoryStore()
      const fake = fakeContext()
      const agentsMap = fake.agents
      const api = new AgentsGateway(fake.ctx, openAuthenticator, '/v1', store, new SessionRegistry(), { ...testGatewayOptions(registry), sandboxPresets })
      const base = await listen((req, res) => api.handle(req, res))
      const call = (path: string, init?: RequestInit) => fetch(`${base}/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'OpenAI-Beta': 'agents=v1' } })
      const env = (await createSettled(call, JSON.stringify({ provider: 'sandbox' }))) as { id: string }
      const session = (body: object) => call('/agents/sessions', { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat' }, ...body }) })
      expect((await session({ environment: { type: 'sandbox', environment_id: env.id } })).status).toBe(200)
      expect((await session({ environment: { type: 'sandbox', environment_id: env.id } })).status).toBe(200)
      expect((await session({ environment: { type: 'none' } })).status).toBe(200)
      const sandboxIds = [...registered.keys()]
      expect(sandboxIds).toHaveLength(1)
      expect(sandboxIds[0]).toMatch(/^agentry-sbx-sbx_/)
      expect(mountedPresets).toEqual([sandboxIds[0], sandboxIds[0], 'agentry'])
      // Sandbox sessions start in full access (sudo works in the container); the local one is untouched.
      const appends = [...agentsMap.values()].map((a) => (a as { session: { append: ReturnType<typeof vi.fn> } }).session.append.mock.calls)
      expect(appends.filter((c) => c.some(([type, data]) => type === 'sandbox/mode' && (data as { mode: string }).mode === 'danger-full-access'))).toHaveLength(2)
      expect(appends.filter((c) => c.length === 0)).toHaveLength(1)
      expect((await call(`/agents/environments/${env.id}`, { method: 'DELETE' })).status).toBe(200)
      expect(registered.size).toBe(0)
    } finally {
      await svc.close()
    }
  })
})

describe('workspace data of sandbox sessions', () => {
  it('artifacts list and read come from the sandbox; a local session still reads host disk', async () => {
    const { startTestService } = await import('@agentry/sandbox/testing')
    const { createAgentrySandboxProvider } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    const { SandboxRegistry } = await import('../src/sandbox/registry.ts')
    const { createSandboxPresets } = await import('../src/sandbox/presets.ts')
    const { mkdir, writeFile } = await import('node:fs/promises')
    const svc = await startTestService()
    const files = new Map<string, string>()
    const envd = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { path?: string }
        if (url.pathname === '/files') {
          const v = files.get(url.searchParams.get('path') ?? '')
          return void (v === undefined ? res.writeHead(404).end('{}') : res.end(v))
        }
        if (url.pathname === '/filesystem.Filesystem/ListDir') {
          const entries = [...files.keys()].filter((p) => p.startsWith(`${body.path ?? ''}/`)).map((p) => ({ name: p.split('/').pop(), type: 'FILE_TYPE_FILE', path: p, size: String(files.get(p)!.length), modifiedTime: '2026-11-24T00:00:00Z' }))
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ entries }))
        }
        if (url.pathname === '/filesystem.Filesystem/Stat') {
          if (!files.has(body.path ?? '')) return void res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'not_found', message: 'no such file' }))
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ entry: { name: 'x', type: 'FILE_TYPE_FILE', path: body.path } }))
        }
        res.writeHead(404).end('{}')
      })
    })
    await new Promise<void>((r) => envd.listen(0, '127.0.0.1', r))
    svc.backend.setEndpoint(`http://127.0.0.1:${String((envd.address() as AddressInfo).port)}`)
    try {
      const root = join(tmpdir(), `agentry-gateway-spec-sbx-data-${String(Date.now())}`)
      const registry = new SandboxRegistry('local')
      registry.register(createLocalProvider(root))
      registry.register(createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: root }))
      const sandboxPresets = createSandboxPresets({ presets: () => ({ register: async () => async () => {} }), rows: () => [] })
      const store = new MemoryStore()
      const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', store, new SessionRegistry(), { ...testGatewayOptions(registry), sandboxPresets })
      const base = await listen((req, res) => api.handle(req, res))
      const call = (path: string, init?: RequestInit) => fetch(`${base}/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'OpenAI-Beta': 'agents=v1' } })
      const env = (await createSettled(call, JSON.stringify({ provider: 'sandbox' }))) as { id: string }
      const sbx = (await (await call('/agents/sessions', { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat' }, environment: { type: 'sandbox', environment_id: env.id } }) })).json()) as { id: string }
      const workspace = (await Promise.all([...svc.ownersSeen].map((o) => svc.service.list(o)))).flat()[0]!.template.workspacePath!
      files.set(`${workspace}/report.md`, '# from the sandbox')
      const listed = (await (await call(`/agents/sessions/${sbx.id}/artifacts`)).json()) as { data: { path: string }[] }
      expect(listed.data.map((e) => e.path)).toEqual(['report.md'])
      const read = await call(`/agents/sessions/${sbx.id}/artifacts/report.md`)
      expect(read.status).toBe(200)
      expect(await read.text()).toBe('# from the sandbox')
      expect((await call(`/agents/sessions/${sbx.id}/artifacts/missing.md`)).status).toBe(404)

      const localDir = join(root, 'local-ws')
      await mkdir(localDir, { recursive: true })
      await writeFile(join(localDir, 'host.md'), 'on host')
      const local = (await (await call('/agents/sessions', { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat' }, environment: { type: 'self_hosted', workspace_directory: localDir } }) })).json()) as { id: string }
      const localListed = (await (await call(`/agents/sessions/${local.id}/artifacts`)).json()) as { data: { path: string }[] }
      expect(localListed.data.map((e) => e.path)).toEqual(['host.md'])
    } finally {
      await svc.close()
      envd.closeAllConnections()
      await new Promise<void>((r) => envd.close(() => r()))
    }
  })
})

describe('failed sandbox environments never fall back to the host (review C1)', () => {
  it('a session on a failed sandbox environment, or one provisioned while the service refuses, is refused and mounts nothing', async () => {
    const { startTestService } = await import('@agentry/sandbox/testing')
    const { createAgentrySandboxProvider } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    const { SandboxRegistry } = await import('../src/sandbox/registry.ts')
    const { createSandboxPresets } = await import('../src/sandbox/presets.ts')
    const svc = await startTestService()
    try {
      const root = join(tmpdir(), 'agentry-gateway-spec-sbx-c1')
      const registry = new SandboxRegistry('local')
      registry.register(createLocalProvider(root))
      registry.register(createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: root }))
      const sandboxPresets = createSandboxPresets({ presets: () => ({ register: async () => async () => {} }), rows: () => [] })
      const store = new MemoryStore()
      const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', store, new SessionRegistry(), { ...testGatewayOptions(registry), sandboxPresets })
      const base = await listen((req, res) => api.handle(req, res))
      const call = (path: string, init?: RequestInit) => fetch(`${base}/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'OpenAI-Beta': 'agents=v1' } })
      svc.backend.failNextCreate('quota: limit 1 reached')
      const env = (await createSettled(call, JSON.stringify({ provider: 'sandbox' }))) as { id: string; status: string }
      expect(env.status).toBe('failed')
      const attach = await call('/agents/sessions', { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat' }, environment: { type: 'sandbox', environment_id: env.id } }) })
      expect(attach.status).toBe(409)
      expect(JSON.stringify(await attach.json())).toContain('environment_failed')
      const tpl = (await (await call('/agents/environments/templates', { method: 'POST', body: JSON.stringify({ name: 't', provider: 'sandbox', config: {} }) })).json()) as { id: string }
      svc.backend.failNextCreate('quota: limit 1 reached')
      const provisioned = await call('/agents/sessions', { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat' }, environment: { type: 'sandbox', template_id: tpl.id } }) })
      expect(provisioned.status).toBe(409)
      expect(mountedPresets).toEqual([])
    } finally {
      await svc.close()
    }
  })
})

describe('a sandbox that cannot start (review I1)', () => {
  it('answers 503 sandbox_unavailable with the reason instead of a generic 500', async () => {
    const { startTestService } = await import('@agentry/sandbox/testing')
    const { createAgentrySandboxProvider } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    const { SandboxRegistry } = await import('../src/sandbox/registry.ts')
    const { createSandboxPresets } = await import('../src/sandbox/presets.ts')
    const svc = await startTestService()
    try {
      const root = join(tmpdir(), 'agentry-gateway-spec-sbx-i1')
      const registry = new SandboxRegistry('local')
      registry.register(createLocalProvider(root))
      registry.register(createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: root }))
      const sandboxPresets = createSandboxPresets({
        presets: () => ({ register: async () => async () => {}, resolve: async (id: string) => ({ id, broken: 'Agentry Sandbox is not reachable for sandbox x' }) }),
        rows: () => [],
      })
      const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), { ...testGatewayOptions(registry), sandboxPresets })
      const base = await listen((req, res) => api.handle(req, res))
      const call = (path: string, init?: RequestInit) => fetch(`${base}/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'OpenAI-Beta': 'agents=v1' } })
      const env = (await createSettled(call, JSON.stringify({ provider: 'sandbox' }))) as { id: string }
      const res = await call('/agents/sessions', { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-chat' }, environment: { type: 'sandbox', environment_id: env.id } }) })
      expect(res.status).toBe(503)
      const body = JSON.stringify(await res.json())
      expect(body).toContain('sandbox_unavailable')
      expect(body).toContain('not reachable')
      expect(body).not.toContain(svc.key)
    } finally {
      await svc.close()
    }
  })
})

describe('built-in templates', () => {
  it('lead the first page when the isolated sandbox is configured, resolve by id, and cannot be changed or deleted', async () => {
    const { startTestService } = await import('@agentry/sandbox/testing')
    const { createAgentrySandboxProvider } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    const { SandboxRegistry } = await import('../src/sandbox/registry.ts')
    const svc = await startTestService()
    try {
      const root = join(tmpdir(), 'agentry-gateway-spec-builtin')
      const withSandbox = new SandboxRegistry('local')
      withSandbox.register(createLocalProvider(root))
      withSandbox.register(createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: root }))
      const serve = async (registry: InstanceType<typeof SandboxRegistry>) => {
        const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(registry))
        const base = await listen((req, res) => api.handle(req, res))
        return (path: string, init?: RequestInit) => fetch(`${base}/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'OpenAI-Beta': 'agents=v1' } })
      }
      const call = await serve(withSandbox)
      const mine = (await (await call('/agents/environments/templates', { method: 'POST', body: JSON.stringify({ name: 'mine', provider: 'sandbox', config: {} }) })).json()) as { id: string }
      const listed = (await (await call('/agents/environments/templates')).json()) as { data: { id: string; name: string; provider: string; image?: string; built_in?: boolean }[] }
      expect(listed.data.map((t) => t.name)).toEqual(['Data science', 'Web and scraping', 'Web and browser', 'Node and TypeScript', 'Offline', 'mine'])
      expect(listed.data.find((t) => t.id === 'tpl_builtin_web_browser')).toMatchObject({ name: 'Web and browser', image: 'ghcr.io/fakhrulfaiz/agentry-sandbox-browser:1' })
      expect(listed.data.filter((t) => t.built_in).every((t) => t.provider === 'sandbox')).toBe(true)
      expect(listed.data.find((t) => t.id === mine.id)?.built_in).toBeUndefined()
      expect(await (await call('/agents/environments/templates/tpl_builtin_offline')).json()).toMatchObject({ name: 'Offline', built_in: true })
      expect((await call('/agents/environments/templates/tpl_builtin_offline', { method: 'POST', body: '{"name":"x"}' })).status).toBe(400)
      expect((await call('/agents/environments/templates/tpl_builtin_offline', { method: 'DELETE' })).status).toBe(400)
      // An environment can start from one.
      const env = (await createSettled(call, JSON.stringify({ provider: 'sandbox', template_id: 'tpl_builtin_data_science' }))) as { status: string; template_id?: string }
      expect(env).toMatchObject({ status: 'connected', template_id: 'tpl_builtin_data_science' })
      // Without the isolated sandbox there are none.
      const plain = new SandboxRegistry('local')
      plain.register(createLocalProvider(root))
      const bare = await serve(plain)
      expect(((await (await bare('/agents/environments/templates')).json()) as { data: unknown[] }).data).toEqual([])
    } finally {
      await svc.close()
    }
  })
})

describe('session create answers before the agent setup finishes', () => {
  function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void
    const promise = new Promise<void>((resolve) => { open = resolve })
    return { promise, open }
  }
  const message = (text: string) => ({
    events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }],
  })
  const texts = (agent: FakeAgent | undefined): string[] => (agent?.followup.mock.calls ?? [])
    .map(call => JSON.stringify(call[0]))
  const settled = async <T>(promise: Promise<T>): Promise<boolean> => {
    let done = false
    void promise.then(() => { done = true }, () => { done = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    return done
  }

  it('answers in_progress while setup runs, then starts the queued first turn', async () => {
    const slow = gate()
    const { base, agents, store } = gateway('', { createGate: slow.promise })
    const root = await base
    const response = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'hello there' }),
    })
    expect(response.status).toBe(200)
    const created = await response.json() as { id: string; status: string }
    expect(created.status).toBe('in_progress')
    expect(agents.get(created.id)).toBeUndefined()
    expect((await store.sessions.get(created.id, TEST_OWNER))?.status).toBe('in_progress')
    expect(await (await fetch(`${root}/v1/agents/sessions/${created.id}`)).json()).toMatchObject({ status: 'in_progress' })

    slow.open()
    await vi.waitFor(() => { expect(agents.get(created.id)?.followup).toHaveBeenCalledOnce() })
    expect(texts(agents.get(created.id))[0]).toContain('hello there')
  })

  it('answers idle without input, then builds the agent', async () => {
    const slow = gate()
    const { base, agents } = gateway('', { createGate: slow.promise })
    const root = await base
    const created = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })).json() as { id: string; status: string }
    expect(created.status).toBe('idle')
    slow.open()
    await vi.waitFor(() => { expect(agents.get(created.id)).toBeDefined() })
  })

  it('holds a follow-up sent during setup until the agent is live, after the first message', async () => {
    const slow = gate()
    const { base, agents } = gateway('', { createGate: slow.promise })
    const root = await base
    const { id } = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'first' }),
    })).json() as { id: string }
    const followUp = fetch(`${root}/v1/agents/sessions/${id}/events`, { method: 'POST', body: JSON.stringify(message('second')) })
    expect(await settled(followUp)).toBe(false)
    slow.open()
    expect((await followUp).status).toBe(200)
    const sent = texts(agents.get(id))
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('first')
    expect(sent[1]).toContain('second')
  })

  it('holds a cancel sent during setup, then drops the queued first message', async () => {
    const slow = gate()
    const { base, agents, store } = gateway('', { createGate: slow.promise })
    const root = await base
    const { id } = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'never mind' }),
    })).json() as { id: string }
    const cancel = fetch(`${root}/v1/agents/sessions/${id}/events`, { method: 'POST', body: JSON.stringify({ events: [{ type: 'agent.session.input.cancel' }] }) })
    expect(await settled(cancel)).toBe(false)
    slow.open()
    const answered = await cancel
    expect(answered.status).toBe(200)
    expect(await answered.json()).toMatchObject({ status: 'idle' })
    expect(agents.get(id)?.followup).not.toHaveBeenCalled()
    expect(agents.get(id)?.cancel).toHaveBeenCalledOnce()
    await vi.waitFor(async () => { expect((await store.sessions.get(id, TEST_OWNER))?.status).toBe('idle') })
  })

  it('marks the session failed and emits error and failed events when setup fails', async () => {
    const slow = gate()
    const { base, agents, store, registry } = gateway('', { createGate: slow.promise, failCreate: true })
    const root = await base
    const stream = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'go', stream: true }),
    })
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`stream ended before ${needle}`)
        text += decoder.decode(chunk.value)
      }
    }
    await readUntil('agent.session.created')
    const id = /"id":"(sess_[0-9a-f]+)"/.exec(text)![1]!
    slow.open()
    await readUntil('agent.session.failed')
    await reader.cancel()
    expect(text.indexOf('agent.session.created')).toBeLessThan(text.indexOf('event: error'))
    expect(text.indexOf('event: error')).toBeLessThan(text.indexOf('agent.session.failed'))
    expect(text).not.toContain('factory failed')

    await vi.waitFor(async () => {
      expect(await store.sessions.get(id, TEST_OWNER)).toMatchObject({ status: 'failed', lastError: 'The session could not be set up' })
    })
    expect(registry.get(id)).toBeUndefined()
    expect(agents.get(id)).toBeUndefined()
    expect(await (await fetch(`${root}/v1/agents/sessions/${id}`)).json()).toMatchObject({ status: 'failed', error: 'The session could not be set up' })
    const later = await fetch(`${root}/v1/agents/sessions/${id}/events`, { method: 'POST', body: JSON.stringify(message('again')) })
    expect(later.status).toBe(409)
    expect(await later.json()).toMatchObject({ error: { code: 'session_setup_failed' } })
  })

  it('streams created first, then starts the turn once setup is done', async () => {
    const slow = gate()
    const { base, agents } = gateway('', { createGate: slow.promise })
    const root = await base
    const stream = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'go', stream: true }),
    })
    const reader = stream.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('agent.session.created')
    const id = /"id":"(sess_[0-9a-f]+)"/.exec(first)![1]!
    expect(agents.get(id)).toBeUndefined()
    slow.open()
    await vi.waitFor(() => { expect(agents.get(id)?.followup).toHaveBeenCalledOnce() })
    await reader.cancel()
  })

  it('deleting a session during setup disposes the agent once setup ends and starts no turn', async () => {
    const slow = gate()
    const { base, agents, store } = gateway('', { createGate: slow.promise })
    const root = await base
    const { id } = await (await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'hi' }),
    })).json() as { id: string }
    const deleted = fetch(`${root}/v1/agents/sessions/${id}`, { method: 'DELETE' })
    expect(await settled(deleted)).toBe(false)
    slow.open()
    expect((await deleted).status).toBe(200)
    expect(agents.get(id)?.followup).not.toHaveBeenCalled()
    expect(await store.sessions.get(id, TEST_OWNER)).toBeUndefined()
  })
})

describe('environment create in the background', () => {
  type FakeCreate = { status: 'pending' | 'connected' | 'failed'; workspacePath: string; handle?: Record<string, string>; error?: string }
  const setup = async () => {
    const { SandboxRegistry } = await import('../src/sandbox/registry.ts')
    const gate: { release: (result: FakeCreate) => void } = { release: () => undefined }
    const state = {
      destroyed: [] as string[],
      created: 0,
      adopt: undefined as undefined | (() => Promise<FakeCreate | undefined>),
      sandboxStatus: 'connected' as 'pending' | 'connected' | 'failed',
    }
    const fake = {
      kind: 'sandbox',
      capabilities: { templateFields: [], files: false, exec: false },
      create: () => {
        state.created++
        return new Promise<FakeCreate>(resolve => { gate.release = resolve })
      },
      adopt: () => (state.adopt ?? (async () => undefined))(),
      status: async (record: { provider_metadata: Record<string, string> }) => {
        if (record.provider_metadata['sandbox_id'] === undefined) throw new Error('environment has no sandbox')
        return state.sandboxStatus
      },
      destroy: async (record: { provider_metadata: Record<string, string> }) => { state.destroyed.push(record.provider_metadata['sandbox_id'] ?? '') },
    }
    const registry = new SandboxRegistry('sandbox')
    registry.register(fake as never)
    const store = new MemoryStore()
    await store.ensureOwner(TEST_OWNER)
    const api = new AgentsGateway(fakeContext().ctx, openAuthenticator, '/v1', store, new SessionRegistry(), testGatewayOptions(registry))
    api.environmentAdoption = { pollMs: 5, maxMs: 2000 }
    const base = await listen((req, res) => api.handle(req, res))
    const call = (path: string, init?: RequestInit) => fetch(`${base}/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'OpenAI-Beta': 'agents=v1' } })
    const post = async () => (await (await call('/agents/environments', { method: 'POST', body: JSON.stringify({ provider: 'sandbox', name: 'Big' }) })).json()) as { id: string; status: string; error?: string; sandbox?: { state: string }; name?: string }
    const get = async (id: string) => (await (await call(`/agents/environments/${id}`)).json()) as { id: string; status: string; error?: string; sandbox?: { state: string }; provider_metadata: Record<string, string> }
    const until = async (id: string, status: string) => {
      for (let i = 0; i < 200; i++) {
        const env = await get(id)
        if (env.status === status) return env
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`environment never became ${status}`)
    }
    return { gate, state, post, get, until, call, store, api }
  }
  const handle = { sandbox_id: 'sbx_1', workspace_directory: '/workspace' }

  it('answers pending as provisioning before create resolves, then connects', async () => {
    const { gate, post, get, until } = await setup()
    const env = await post()
    expect(env).toMatchObject({ status: 'pending', name: 'Big', sandbox: { state: 'provisioning' } })
    expect(await get(env.id)).toMatchObject({ status: 'pending', sandbox: { state: 'provisioning' } })
    gate.release({ status: 'connected', workspacePath: '/workspace', handle })
    const done = await until(env.id, 'connected')
    expect(done.provider_metadata).toMatchObject({ sandbox_id: 'sbx_1', name: 'Big' })
  })

  it('stores a failed create with its error', async () => {
    const { gate, post, until } = await setup()
    const env = await post()
    gate.release({ status: 'failed', workspacePath: '', error: 'out of memory' })
    expect(await until(env.id, 'failed')).toMatchObject({ error: 'out of memory' })
  })

  it('adopts a sandbox the service kept making after the create timed out', async () => {
    const { gate, state, post, until } = await setup()
    let polls = 0
    state.adopt = async () => (++polls < 3 ? { status: 'pending', workspacePath: '/workspace', handle } : { status: 'connected', workspacePath: '/workspace', handle })
    const env = await post()
    gate.release({ status: 'failed', workspacePath: '', error: 'Agentry Sandbox is not reachable: The operation was aborted due to timeout' })
    const done = await until(env.id, 'connected')
    expect(done.provider_metadata['sandbox_id']).toBe('sbx_1')
    expect(done.error).toBeUndefined()
  })

  it('keeps the failure when a timed-out create left no sandbox', async () => {
    const { gate, post, until } = await setup()
    const env = await post()
    gate.release({ status: 'failed', workspacePath: '', error: 'The operation was aborted due to timeout' })
    expect(await until(env.id, 'failed')).toMatchObject({ error: expect.stringContaining('timeout') })
  })

  it('destroys what a setup made when the environment was deleted meanwhile', async () => {
    const { gate, state, post, call } = await setup()
    const env = await post()
    expect((await call(`/agents/environments/${env.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call(`/agents/environments/${env.id}`)).status).toBe(404)
    gate.release({ status: 'connected', workspacePath: '/workspace', handle })
    for (let i = 0; i < 100 && state.destroyed.length === 0; i++) await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(state.destroyed).toEqual(['sbx_1'])
    expect((await call(`/agents/environments/${env.id}`)).status).toBe(404)
  })

  it('marks a pending record nobody is setting up (API restarted) as interrupted', async () => {
    const { store, get, call } = await setup()
    await store.environments.create(TEST_OWNER, { id: 'env_orphan', object: 'environment', status: 'pending', provider: 'sandbox', provider_metadata: {}, created_at: 1 })
    const listed = (await (await call('/agents/environments')).json()) as { data: { id: string; status: string; error?: string }[] }
    expect(listed.data.find(e => e.id === 'env_orphan')).toMatchObject({ status: 'failed', error: 'Setup was interrupted.' })
    expect(await get('env_orphan')).toMatchObject({ status: 'failed' })
  })

  it('keeps in-chat provisioning synchronous', async () => {
    const { gate, state, api } = await setup()
    let resolved = false
    const pending = api.provisionEnvironment(TEST_OWNER, { provider: 'sandbox' }).then(env => { resolved = true; return env })
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    expect(state.created).toBe(1)
    expect(resolved).toBe(false)
    gate.release({ status: 'connected', workspacePath: '/workspace', handle })
    expect(await pending).toMatchObject({ status: 'connected' })
  })
})
