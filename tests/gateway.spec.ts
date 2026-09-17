import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AgentStore } from '../src/agent-store.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { badRequest, json, notFound, readBody } from '../src/http.ts'

const servers: Server[] = []

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
}

function fakeContext(options?: { failCreate?: boolean; failFollowup?: boolean; failDispose?: boolean }): {
  ctx: Context
  agents: Map<string, FakeAgent>
} {
  const agents = new Map<string, FakeAgent>()
  const sessions = new Map<string, { id: string }>()
  const ctx = {
    agents: {
      create: async ({ sessionId }: { sessionId: string }) => {
        if (options?.failCreate) throw new Error('factory failed')
        const agent: FakeAgent = {
          id: sessionId,
          followup: vi.fn(() => {
            if (options?.failFollowup) throw 'followup failed'
          }),
          steer: vi.fn(),
          cancel: vi.fn(),
        }
        agents.set(sessionId, agent)
        sessions.set(sessionId, { id: sessionId })
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
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    },
  } as unknown as Context
  return { ctx, agents }
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

function gateway(apiKey = '', options?: { failCreate?: boolean; failFollowup?: boolean; failDispose?: boolean }): {
  base: Promise<string>
  store: AgentStore
  registry: SessionRegistry
  agents: Map<string, FakeAgent>
} {
  const { ctx, agents } = fakeContext(options)
  const store = new AgentStore()
  const registry = new SessionRegistry()
  const api = new AgentsGateway(ctx, apiKey, '/v1', store, registry)
  return {
    base: listen((req, res) => api.handle(req, res)),
    store,
    registry,
    agents,
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
  it('rejects a missing bearer token when apiKey is set', async () => {
    const base = await gateway('secret').base
    expect((await fetch(`${base}/v1/agents`)).status).toBe(401)
    expect((await fetch(`${base}/v1/agents`, { headers: { authorization: 'Bearer secret' } })).status).toBe(200)
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
    expect(store.get(created.id)).toBeUndefined()
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

    const saved = store.create({ model: 'deepseek-chat', instructions: 'saved' })
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
    const { base, agents, registry } = gateway()
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
    registry.createTurn(sessionId)
    expect(registry.get(sessionId)?.status).toBe('in_progress')

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
    })).status).toBe(200)

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
    const turnId = registry.listTurns(sessionId, { limit: 20 }).data[0]?.id
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
          registry.emit(sessionId, {
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
          { type: 'agent.session.input.function_call_output', call_id: 'c1', output: 'plain' },
          { type: 'agent.session.input.cancel' },
        ],
      }),
    })).status).toBe(200)
    expect(agents.get(idle.id)?.followup).toHaveBeenCalled()
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
    const api = new AgentsGateway(ctx, '', '/v1', new AgentStore(), new SessionRegistry())
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

    const { base, registry, store, agents } = gateway()
    const root = await base
    const saved = store.create({ model: 'deepseek-chat', instructions: 'saved' })
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

    registry.register('sess_orphan', saved)
    expect((await fetch(`${root}/v1/agents/sessions/sess_orphan`, { method: 'DELETE' })).status).toBe(200)

    const liveId = reused.id
    registry.createTurn(liveId)
    const live = await fetch(`${root}/v1/agents/sessions/${liveId}/events`)
    const reader = live.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('agent.session.in_progress')
    registry.emit(liveId, {
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
})
