/**
 * Gateway behavior that depends on the Session log: replay across restart,
 * lazy resume, status writes, and index-only listing.
 */

import { APP_TOOLS } from '../src/mount-composio-app-tools.ts'
import { fakeLlm, fakeModel } from './support/fake-model.ts'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { createSessionHistory } from '../src/history/session-history.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { MemoryStore } from './support/memory-store.ts'
import { FakeSessionQuery, logEvent, testGatewayOptions } from './support/fake-session-query.ts'
import { openAuthenticator } from './open-auth.ts'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({
  Config: (input: Record<string, unknown>) => ({ ...input }),
  name: 'mcp-client',
}))

const OWNER = ownerId('test')
const environments = createLocalProvider(join(tmpdir(), 'agentry-gateway-history-spec'))
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

interface Process {
  api: AgentsGateway
  registry: SessionRegistry
  origin: string
  resume: ReturnType<typeof vi.fn<(options: ResumeAgentOptions) => Promise<unknown>>>
  agents: Map<string, { followup: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }>
  /** Configs passed to `agentCtx.plugin`, in call order. */
  plugins: unknown[]
  tools: Array<{ name: string; execute: (args: unknown, exec: { callId: string; signal: AbortSignal }) => Promise<unknown> }>
  logger: { warn: ReturnType<typeof vi.fn> }
  /** Called inside `agents.create`, after the agent exists and before it returns. */
  hooks: { duringCreate?: (sessionId: string) => void }
  /** Disposers of agents handed out by `create` and `resume`. */
  disposers: Array<ReturnType<typeof vi.fn>>
  /** Log `event` and project it, as a live `session/event` does. */
  feed(sessionId: string, event: SessionEvent): void
}

/**
 * One server process over a shared Postgres stand-in and Session log. Calling
 * it again with the same `store` and `query` models a restart.
 * @param store - session index shared across restarts.
 * @param query - Session log shared across restarts.
 * @param failResume - message `agents.resume` rejects with.
 * @param failFollowup - make every agent's `followup` throw.
 */
async function startProcess(store: MemoryStore, query: FakeSessionQuery, failResume?: string, failFollowup = false): Promise<Process> {
  const agents: Process['agents'] = new Map()
  const tools: Process['tools'] = []
  const plugins: unknown[] = []
  const logger = { warn: vi.fn() }
  const hooks: Process['hooks'] = {}
  const disposers: Process['disposers'] = []
  const make = async (sessionId: string, setup?: (agentCtx: unknown) => Promise<void>) => {
    const agent = {
      followup: vi.fn(() => {
        if (failFollowup) throw new Error('followup failed')
      }),
      steer: vi.fn(),
      cancel: vi.fn(),
      model: fakeModel(),
    }
    agents.set(sessionId, agent)
    const systemPrompt = { section: () => undefined, getSectionOrder: () => 2500 }
    await setup?.({
      get: (name: string) => name === 'systemPrompt' ? systemPrompt : undefined,
      systemPrompt,
      plugin: (_plugin: unknown, config: unknown) => { plugins.push(config); return Promise.resolve() },
      tools: { register: (definition: Process['tools'][number]) => { if (!definition.name.startsWith('agent_')) tools.push(definition); return () => undefined }, restrict: () => () => undefined, guard: () => () => undefined },
    })
    hooks.duringCreate?.(sessionId)
    const dispose = vi.fn(() => Promise.resolve())
    disposers.push(dispose)
    return { agent, dispose }
  }
  const resume = vi.fn<(options: ResumeAgentOptions) => Promise<unknown>>((options) => {
    if (failResume !== undefined) return Promise.reject(new Error(failResume))
    return make(options.resumeSessionId, options.setup as never)
  })
  const ctx = {
    agents: {
      create: ({ sessionId, setup }: { sessionId: string; setup?: never }) => make(sessionId, setup),
      resume,
      get: (id: string) => agents.get(id),
    },
    sessions: { get: (id: string) => agents.has(id) ? { id } : undefined },
    tools: { schemas: () => [] },
    llm: fakeLlm(),
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    logger,
  } as unknown as Context
  const registry = new SessionRegistry()
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, registry, testGatewayOptions(environments, query))
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  servers.push(server)
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  return {
    api,
    registry,
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    resume,
    agents,
    plugins,
    tools,
    logger,
    hooks,
    disposers,
    feed: (sessionId, event) => {
      query.append(sessionId, event)
      api.applySessionEvent(sessionId, event)
    },
  }
}

async function createSession(origin: string, body: object = { agent: { model: 'deepseek-chat' } }): Promise<string> {
  const response = await fetch(`${origin}/v1/agents/sessions`, { method: 'POST', body: JSON.stringify(body) })
  return ((await response.json()) as { id: string }).id
}

/** Read SSE chunks until `done(text)` holds or no chunk arrives within `quietMs`. */
async function readStream(response: Response, done: (text: string) => boolean, quietMs = 300): Promise<string> {
  const reader = response.body!.getReader()
  let text = ''
  for (;;) {
    const next = await Promise.race([reader.read(), new Promise<'quiet'>(resolve => setTimeout(resolve, quietMs, 'quiet'))])
    if (next === 'quiet' || next.done) break
    text += new TextDecoder().decode(next.value)
    if (done(text)) break
  }
  await reader.cancel()
  return text
}

const frameIds = (text: string) => [...text.matchAll(/^id: (\d+)$/gmu)].map(match => Number(match[1]))
const frameTypes = (text: string) => [...text.matchAll(/^event: (.+)$/gmu)].map(match => match[1])

const user = (seq: number) => logEvent('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, seq)

const APP_TOOL_NAMES = new Set(APP_TOOLS.map(tool => tool.name))

describe('SSE replay', () => {
  it('replays across restart: Last-Event-ID yields exactly the missed events, then live, with no duplicates', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin)
    // Live frames: 1 created, 2-4 turn start, 5-8 assistant message.
    first.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    first.feed(id, user(2))
    first.feed(id, logEvent('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } }, 3))
    const beforeRestart = await readStream(await fetch(`${first.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '0' } }), text => frameIds(text).length >= 8)
    expect(frameIds(beforeRestart)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    // The process dies mid-turn; a new one serves the same log and index.
    query.crash()
    const second = await startProcess(store, query)
    const stream = await fetch(`${second.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '2' } })
    // Resume appends the closers the cold read already showed, then the session goes live at the next frame id.
    await second.api.resumeSession((await store.sessions.get(id, 'any'))!)
    expect(second.registry.get(id)!.projector.nextId).toBe(11)
    second.feed(id, logEvent('turn/start', { turn: 2 }, 6))
    const text = await readStream(stream, seen => frameIds(seen).includes(13))

    // Replayed: 3..10 (rest of turn 1, its cancellation, idle); live: 11..13 (turn 2 starting).
    expect(frameIds(text)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(frameTypes(text).slice(-3)).toEqual(['agent.session.in_progress', 'agent.session.turn.created', 'agent.session.turn.in_progress'])
    expect(new Set(frameIds(text)).size).toBe(frameIds(text).length)
  })

  it('streams item frames with sub-numbered ids and resumes from one', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const process = await startProcess(store, query)
    const id = await createSession(process.origin)
    process.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    process.feed(id, user(2))
    process.feed(id, logEvent('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } }, 3))
    const allIds = (text: string) => [...text.matchAll(/^id: ([\d.]+)$/gmu)].map(match => match[1])
    const whole = await readStream(await fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '0' } }), text => allIds(text).length >= 9)
    // The user message is an item frame after frame 4 (turn.in_progress).
    expect(allIds(whole)).toEqual(['1', '2', '3', '4', '4.1', '5', '6', '7', '8'])
    expect(whole).toContain('"role":"user"')
    // An old integer id still resumes at the same place; a sub id resumes after that item frame.
    const fromFour = await readStream(await fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '4' } }), text => allIds(text).length >= 5)
    expect(allIds(fromFour)).toEqual(['4.1', '5', '6', '7', '8'])
    const fromItem = await readStream(await fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '4.1' } }), text => allIds(text).length >= 4)
    expect(allIds(fromItem)).toEqual(['5', '6', '7', '8'])
  })

  it('live frames carry the ids a later replay assigns', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const process = await startProcess(store, query)
    const id = await createSession(process.origin)
    const live = fetch(`${process.origin}/v1/agents/sessions/${id}/events`)
    await new Promise(resolve => setTimeout(resolve, 50))
    process.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    process.feed(id, logEvent('turn/end', { reason: { kind: 'completed' } }, 2))
    const liveText = await readStream(await live, text => frameIds(text).length >= 6)
    const replayText = await readStream(await fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '1' } }), text => frameIds(text).length >= 6)
    expect(frameIds(liveText)).toEqual([2, 3, 4, 5, 6])
    expect(frameIds(replayText)).toEqual(frameIds(liveText))
    expect(frameTypes(replayText)).toEqual(frameTypes(liveText).slice(1))
  })

  it('does not duplicate a frame that is both in the log fold and in the live buffer', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const process = await startProcess(store, query)
    const id = await createSession(process.origin)
    process.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    let release!: () => void
    query.gateBeforeSnapshot = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '1' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    // Subscribed and waiting to read the log: this event reaches the buffer and the snapshot.
    process.feed(id, logEvent('turn/end', { reason: { kind: 'completed' } }, 2))
    release()
    const text = await readStream(await pending, seen => frameIds(seen).length >= 7)
    expect(frameIds(text)).toEqual([2, 3, 4, 5, 6])
  })

  it('does not lose a frame produced after the log was read', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const process = await startProcess(store, query)
    const id = await createSession(process.origin)
    process.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    let release!: () => void
    query.gateAfterSnapshot = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '1' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    // The snapshot already ended at turn/start; this event is only in the live buffer.
    process.feed(id, logEvent('turn/end', { reason: { kind: 'completed' } }, 2))
    release()
    const text = await readStream(await pending, seen => frameIds(seen).length >= 5)
    expect(frameIds(text)).toEqual([2, 3, 4, 5, 6])
  })

  it('sends the connect-time status snapshot and dispatch errors without an id', async () => {
    const store = new MemoryStore()
    const process = await startProcess(store, new FakeSessionQuery())
    const id = await createSession(process.origin)
    const snapshot = await readStream(await fetch(`${process.origin}/v1/agents/sessions/${id}/events`), text => text.includes('\n\n'))
    expect(snapshot).toMatch(/^event: agent\.session\.idle\n/u)
    expect(frameIds(snapshot)).toEqual([])

    const failing = await startProcess(store, new FakeSessionQuery(), undefined, true)
    const created = await fetch(`${failing.origin}/v1/agents/sessions?stream=true`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'go' }),
    })
    const text = await readStream(created, seen => seen.includes('event: error'))
    expect(text).toMatch(/^id: 1\nevent: agent\.session\.created\n/u)
    expect(text).toMatch(/\nevent: error\ndata: .*followup failed/u)
    expect(text).not.toMatch(/id: \d+\nevent: error/u)
    // The error took no frame id: the next logged frame is 2.
    const sessionId = /"id":"(sess_[^"]+)"/u.exec(text)![1]!
    failing.feed(sessionId, logEvent('turn/start', { turn: 1 }, 1))
    const replay = await readStream(await fetch(`${failing.origin}/v1/agents/sessions/${sessionId}/events`, { headers: { 'last-event-id': '1' } }), seen => frameIds(seen).length >= 3)
    expect(frameIds(replay)).toEqual([2, 3, 4])
  })

  it('treats a non-numeric Last-Event-ID as a request for the whole history', async () => {
    const process = await startProcess(new MemoryStore(), new FakeSessionQuery())
    const id = await createSession(process.origin)
    const text = await readStream(await fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': 'abc' } }), seen => frameIds(seen).length >= 1)
    expect(frameIds(text)).toEqual([1])
  })

  it('sends a status snapshot of the matching type for a failed session', async () => {
    const store = new MemoryStore()
    const first = await startProcess(store, new FakeSessionQuery())
    const id = await createSession(first.origin)
    first.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    first.feed(id, logEvent('turn/end', { reason: { kind: 'error', error: { message: 'boom', code: 'E' } } }, 2))
    const live = await readStream(await fetch(`${first.origin}/v1/agents/sessions/${id}/events`), text => text.includes('\n\n'))
    expect(live).toMatch(/^event: agent\.session\.failed\n/u)
    await first.api.statusWritesSettled()
    const cold = await startProcess(store, new FakeSessionQuery())
    expect(await readStream(await fetch(`${cold.origin}/v1/agents/sessions/${id}/events`), text => text.includes('\n\n'))).toMatch(/^event: agent\.session\.failed\n/u)
  })

  it('answers a replay read failure by ending the stream', async () => {
    const query = new FakeSessionQuery()
    const process = await startProcess(new MemoryStore(), query)
    const id = await createSession(process.origin)
    query.readSession = () => Promise.reject(new Error('disk gone'))
    const response = await fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '1' } })
    expect(await response.text()).toBe('')
    expect(process.logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk gone'))
  })
})

describe('create', () => {
  it('live frames of a new session equal the fold of its log, including events logged during creation', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const process = await startProcess(store, query)
    // The Host logs a turn while the agent is still being created.
    process.hooks.duringCreate = (sessionId) => {
      process.feed(sessionId, logEvent('turn/start', { turn: 1 }, 1))
    }
    const id = await createSession(process.origin)
    delete process.hooks.duringCreate
    process.feed(id, user(2))
    process.feed(id, logEvent('turn/end', { reason: { kind: 'completed' } }, 3))

    const live = process.registry.get(id)!.projector
    const folded = await createSessionHistory(query).fold(live.base)
    expect(live.nextId).toBe(folded.nextId)
    expect(live.items).toEqual(folded.items)
    expect(live.turns).toEqual(folded.turns)
    expect(live.turns.map(turn => turn.id)).toEqual(['turn_1'])
  })

  it('folds the log once for the create response', async () => {
    const query = new FakeSessionQuery()
    const process = await startProcess(new MemoryStore(), query)
    await createSession(process.origin)
    expect(query.reads).toBe(1)
  })
})

describe('history routes after restart', () => {
  it('serves items, turns, and the session from the log and index', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin, { agent: { model: 'deepseek-chat', instructions: 'brief' }, metadata: { k: 'v' } })
    first.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    first.feed(id, user(2))
    first.feed(id, logEvent('turn/end', { reason: { kind: 'completed' } }, 3))
    await first.api.statusWritesSettled()
    query.crash()

    const second = await startProcess(store, query)
    const items = await (await fetch(`${second.origin}/v1/agents/sessions/${id}/items`)).json() as { data: Array<{ id: string }> }
    const turns = await (await fetch(`${second.origin}/v1/agents/sessions/${id}/turns`)).json() as { data: Array<{ id: string; status: string }> }
    const turn = await (await fetch(`${second.origin}/v1/agents/sessions/${id}/turns/turn_1`)).json() as { status: string }
    const session = await (await fetch(`${second.origin}/v1/agents/sessions/${id}`)).json() as { status: string; metadata: object; agent: { instructions: string } }
    expect(items.data.map(item => item.id)).toEqual(['item_msg_2'])
    expect(turns.data).toMatchObject([{ id: 'turn_1', status: 'completed' }])
    expect(turn.status).toBe('completed')
    expect(session).toMatchObject({ status: 'idle', metadata: { k: 'v' }, agent: { instructions: 'brief' } })
    expect((await fetch(`${second.origin}/v1/agents/sessions/${id}/turns/turn_9`)).status).toBe(404)
  })

  it('serves subagents, their turns and items from the child logs after restart, as live', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin)
    const other = await createSession(first.origin)
    query.headers.set('child_1', { parentSession: id, origin: 'subagent', createdAt: 4_000 })
    query.headers.set('child_x', { parentSession: other, origin: 'subagent', createdAt: 4_000 })
    const child = [
      logEvent('request/header', { header: { config: { model: 'deepseek-flash' } }, reason: 'initial' }, 0, 4_000),
      logEvent('turn/start', { turn: 1 }, 1, 4_000),
      logEvent('user/message', { content: [{ type: 'text', text: 'look' }], source: { kind: 'user' } }, 2, 4_100),
      logEvent('assistant/message', { message: { content: [{ type: 'text', text: 'seen' }] } }, 3, 4_200),
      logEvent('turn/end', { reason: { kind: 'completed' } }, 4, 5_000),
    ]
    for (const event of child) {
      query.append('child_1', event)
      first.registry.applyChildEvent(id, 'child_1', event, 4_000)
    }
    query.append('child_x', child[1]!)
    first.registry.closeSubagent(id, 'child_1')
    const read = async (origin: string, path: string) => (await fetch(`${origin}/v1/agents/sessions/${id}/subagents${path}`)).json() as Promise<unknown>
    const paths = ['', '/child_1', '/child_1/turns', '/child_1/turns/turn_1', '/child_1/items', '/child_1/turns/turn_1/items']
    const live = await Promise.all(paths.map(path => read(first.origin, path)))
    query.crash()

    const second = await startProcess(store, query)
    expect(second.registry.listSubagents(id)).toEqual([])
    const rebuilt = await Promise.all(paths.map(path => read(second.origin, path)))
    expect(rebuilt).toEqual(live)
    expect(rebuilt[0]).toMatchObject({ data: [{ id: 'child_1', status: 'closed', created_at: 4, closed_at: 5, model: 'deepseek-flash' }] })
    expect((rebuilt[4] as { data: unknown[] }).data).toHaveLength(2)
    // A child is reachable only through its own parent, whose owner was checked.
    expect((await fetch(`${second.origin}/v1/agents/sessions/${id}/subagents/child_x`)).status).toBe(404)
    expect((await fetch(`${second.origin}/v1/agents/sessions/${id}/subagents/child_1/turns/turn_9`)).status).toBe(404)
  })

  it('replays a slash command result as a turn-less item across restart', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin, { agent: { model: 'deepseek-chat' } })
    first.feed(id, logEvent('command/run', { commandId: 'c1', name: 'compact', source: { kind: 'user' } }, 1))
    first.feed(id, logEvent('command/done', { commandId: 'c1', kind: 'success', text: 'Compacted' }, 2))
    await first.api.statusWritesSettled()
    query.crash()

    const second = await startProcess(store, query)
    const items = await (await fetch(`${second.origin}/v1/agents/sessions/${id}/items`)).json() as { data: unknown[] }
    expect(items.data).toEqual([{ id: 'item_cmd_1', type: 'slash_command', command_id: 'c1', name: 'compact', status: 'completed', text: 'Compacted', turn_id: null }])
    const events = await fetch(`${second.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '1' } })
    const reader = events.body!.getReader()
    const text = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    expect(text).toContain('event: agent.session.item.done')
  })

  it('lists sessions from index rows with consistent first_id, last_id, and has_more', async () => {
    const store = new MemoryStore()
    const first = await startProcess(store, new FakeSessionQuery())
    const ids = [await createSession(first.origin), await createSession(first.origin), await createSession(first.origin)]
    const second = await startProcess(store, new FakeSessionQuery())

    const page1 = await (await fetch(`${second.origin}/v1/agents/sessions?limit=2`)).json() as { data: Array<{ id: string }>; first_id: string; last_id: string; has_more: boolean }
    expect(page1.data).toHaveLength(2)
    expect(page1).toMatchObject({ first_id: page1.data[0]!.id, last_id: page1.data[1]!.id, has_more: true })
    const page2 = await (await fetch(`${second.origin}/v1/agents/sessions?limit=2&after=${page1.last_id}`)).json() as { data: Array<{ id: string }>; has_more: boolean }
    expect([...page1.data, ...page2.data].map(row => row.id).sort()).toEqual([...ids].sort())
    expect(page2.has_more).toBe(false)
  })

  it('shows interrupted sessions as failed with the recorded reason', async () => {
    const store = new MemoryStore()
    const first = await startProcess(store, new FakeSessionQuery())
    const id = await createSession(first.origin)
    await store.sessions.update(id, 'any', { status: 'interrupted', lastError: 'log is corrupt' })
    const cold = await startProcess(store, new FakeSessionQuery())
    expect(await (await fetch(`${cold.origin}/v1/agents/sessions/${id}`)).json()).toMatchObject({ status: 'failed', error: 'log is corrupt' })
  })

  it('answers 404 for artifacts of a session whose log has no workspace', async () => {
    const store = new MemoryStore()
    const first = await startProcess(store, new FakeSessionQuery())
    const id = await createSession(first.origin)
    const cold = await startProcess(store, new FakeSessionQuery())
    expect((await fetch(`${cold.origin}/v1/agents/sessions/${id}/artifacts`)).status).toBe(404)
    expect((await fetch(`${cold.origin}/v1/agents/sessions/${id}/artifacts/x.txt`)).status).toBe(404)
  })
})

describe('status writes', () => {
  it('writes the status where the matching wire event is produced', async () => {
    const store = new MemoryStore()
    const process = await startProcess(store, new FakeSessionQuery())
    const id = await createSession(process.origin, { agent: { model: 'deepseek-chat', tools: [{ type: 'function', name: 'get_weather' }] } })
    const statusAfter = async (event: SessionEvent) => {
      process.feed(id, event)
      await process.api.statusWritesSettled()
      return store.sessions.get(id, 'any')
    }

    expect(await statusAfter(logEvent('turn/start', { turn: 1 }, 1))).toMatchObject({ status: 'in_progress', lastError: null })
    expect(await statusAfter(logEvent('tool/call', { callId: 'c', name: 'get_weather', arguments: '{}' }, 2))).toMatchObject({ status: 'requires_action' })
    expect(await statusAfter(logEvent('tool/result', { message: { source: { kind: 'tool', callId: 'c' }, content: [] } }, 3))).toMatchObject({ status: 'in_progress' })
    expect(await statusAfter(logEvent('turn/end', { reason: { kind: 'completed' } }, 4))).toMatchObject({ status: 'idle' })
    expect(await statusAfter(logEvent('turn/start', { turn: 2 }, 5))).toMatchObject({ status: 'in_progress' })
    expect(await statusAfter(logEvent('turn/end', { reason: { kind: 'error', error: { message: 'boom', code: 'E' } } }, 6))).toMatchObject({ status: 'failed', lastError: 'boom' })
    expect((await store.sessions.listResumable())).toEqual([])
    expect(await statusAfter(logEvent('turn/start', { turn: 3 }, 7))).toMatchObject({ status: 'in_progress', lastError: null })
    expect((await store.sessions.listResumable()).map(row => row.id)).toEqual([id])
  })

  it('logs a failed status write instead of throwing into the event listener', async () => {
    const store = new MemoryStore()
    const process = await startProcess(store, new FakeSessionQuery())
    const id = await createSession(process.origin)
    store.failure = new Error('db down')
    expect(() => process.feed(id, logEvent('turn/start', { turn: 1 }, 1))).not.toThrow()
    await process.api.statusWritesSettled()
    expect(process.logger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'))
  })

  it('skips status writes while no store is attached', async () => {
    const process = await startProcess(new MemoryStore(), new FakeSessionQuery())
    process.api.detachStore()
    expect(() => process.api.recordStatus('sess_x', 'idle', null)).not.toThrow()
    await process.api.statusWritesSettled()
  })
})

describe('resume', () => {
  it('registers a projector seeded with the closer events before agents.resume runs', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin)
    first.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    first.feed(id, user(2))
    await first.api.statusWritesSettled()
    expect((await store.sessions.get(id, 'any'))?.status).toBe('in_progress')
    query.crash()

    const second = await startProcess(store, query)
    let seeded: number | undefined
    second.resume.mockImplementationOnce(async (options) => {
      seeded = second.registry.get(options.resumeSessionId)?.projector.nextId
      return { agent: {}, dispose: vi.fn() }
    })
    await second.api.resumeSession((await store.sessions.get(id, 'any'))!)
    // created + turn start (3) + cancelled + idle.
    expect(seeded).toBe(7)
    expect(second.resume.mock.calls[0]![0].resumeSessionId).toBe(id)
    await second.api.statusWritesSettled()
    expect(await store.sessions.get(id, 'any')).toMatchObject({ status: 'idle' })
  })

  it('removes the registered projector when agents.resume fails', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin)
    first.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    query.crash()
    const second = await startProcess(store, query, 'cannot resume: nope')
    await expect(second.api.resumeSession((await store.sessions.get(id, 'any'))!)).rejects.toThrow('cannot resume: nope')
    expect(second.registry.get(id)).toBeUndefined()
  })

  it('undoes a lazy resume when the session is deleted while it is in flight', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin)
    first.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    query.crash()
    const second = await startProcess(store, query)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispose = vi.fn(() => Promise.resolve())
    second.resume.mockImplementationOnce(async () => {
      await gate
      return { agent: {}, dispose }
    })
    const posted = fetch(`${second.origin}/v1/agents/sessions/${id}/events`, { method: 'POST', body: '{"events":[]}' })
    await new Promise(resolve => setTimeout(resolve, 50))
    await store.sessions.delete(id, 'any')
    release()
    await posted
    expect(dispose).toHaveBeenCalledOnce()
    expect(second.registry.get(id)).toBeUndefined()
  })

  it('fails when the session log has no working directory', async () => {
    const store = new MemoryStore()
    const first = await startProcess(store, new FakeSessionQuery())
    const id = await createSession(first.origin)
    const second = await startProcess(store, new FakeSessionQuery())
    await expect(second.api.resumeSession((await store.sessions.get(id, 'any'))!)).rejects.toThrow(/no working directory/)
  })

  it('resumes lazily when an event is posted to a session that is not live, mounting its function tools', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin, { agent: { model: 'deepseek-chat', tools: [{ type: 'function', name: 'get_weather' }] } })
    first.feed(id, logEvent('turn/start', { turn: 1 }, 1))
    first.feed(id, logEvent('step/start', { turn: 1, step: 1 }, 2))
    first.feed(id, logEvent('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-call', id: 'old_call', name: 'get_weather', arguments: '{}' }] },
    }, 3))
    first.feed(id, logEvent('tool/call', { callId: 'old_call', name: 'get_weather', arguments: '{}' }, 4))
    query.crash()

    const second = await startProcess(store, query)
    const post = (body: object) => fetch(`${second.origin}/v1/agents/sessions/${id}/events`, { method: 'POST', body: JSON.stringify(body) })
    const posted = await Promise.all([
      post({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'again' }] }] }] }),
      post({ events: [] }),
    ])
    expect(posted.map(response => response.status)).toEqual([200, 200])
    expect(second.resume).toHaveBeenCalledOnce()
    expect(second.tools.map(tool => tool.name).filter(name => !name.startsWith('skill_') && !APP_TOOL_NAMES.has(name))).toEqual(['get_weather'])
    expect(second.agents.get(id)!.followup).toHaveBeenCalledOnce()

    // The call parked before the restart was closed by the Session layer; a late result for it is refused.
    const stale = await post({ events: [{ type: 'agent.session.input.tool_result', turn_id: 'turn_1', call_id: 'old_call', success: true, output: 'x' }] })
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({ error: { code: 'unknown_call_id' } })
    const items = await (await fetch(`${second.origin}/v1/agents/sessions/${id}/items`)).json() as { data: Array<{ type: string; status: string }> }
    expect(items.data.map(item => [item.type, item.status])).toEqual([['message', 'completed'], ['function_call', 'in_progress'], ['function_call_output', 'failed']])
    expect((await (await fetch(`${second.origin}/v1/agents/sessions/${id}`)).json() as { required_actions: unknown[] }).required_actions).toEqual([])
  })

  it('answers 409 for a session without a stored setup and 500 when resume fails', async () => {
    const store = new MemoryStore()
    await store.ensureOwner(OWNER)
    const at = new Date()
    const legacy = { ownerId: OWNER, agentId: null, environmentId: null, projectId: null, status: 'idle' as const, lastError: null, model: 'deepseek-chat', reasoningEffort: null, createdAt: at, updatedAt: at }
    await store.sessions.insert({ ...legacy, id: 'sess_legacy', dshSessionId: 'sess_legacy', body: null })
    const query = new FakeSessionQuery()
    query.append('sess_legacy', logEvent('turn/start', { turn: 1 }, 1))
    const process = await startProcess(store, query)
    const post = (id: string) => fetch(`${process.origin}/v1/agents/sessions/${id}/events`, { method: 'POST', body: '{"events":[]}' })
    const refused = await post('sess_legacy')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: 'session_not_resumable' } })
    expect(await (await fetch(`${process.origin}/v1/agents/sessions/sess_legacy`)).json()).toMatchObject({ id: 'sess_legacy', agent: { model: 'deepseek-chat' } })

    const created = await createSession(process.origin)
    const failing = await startProcess(store, query, 'boom')
    query.crash()
    const failed = await fetch(`${failing.origin}/v1/agents/sessions/${created}/events`, { method: 'POST', body: '{"events":[]}' })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ error: { code: 'session_resume_failed' } })
  })
})

describe('session settings', () => {
  it('answers 404 when the session row vanishes during an update', async () => {
    const store = new MemoryStore()
    let vanished = false
    const update = store.sessions.update
    store.sessions.update = (...args) => vanished ? Promise.resolve(undefined) : update(...args)
    const process = await startProcess(store, new FakeSessionQuery())
    const id = await createSession(process.origin)
    vanished = true
    const response = await fetch(`${process.origin}/v1/agents/sessions/${id}`, { method: 'POST', body: JSON.stringify({ agent: { model: 'deepseek-v4-flash' } }) })
    expect(response.status).toBe(404)
  })

  it('persists the update in the row body so it survives a restart', async () => {
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const id = await createSession(first.origin)
    const updated = await fetch(`${first.origin}/v1/agents/sessions/${id}`, {
      method: 'POST',
      body: JSON.stringify({ agent: { model: 'deepseek-v4-flash', reasoning: { effort: 'low' } }, metadata: { n: '1' } }),
    })
    expect(await updated.json()).toMatchObject({ agent: { model: 'deepseek-v4-flash' }, metadata: { n: '1' } })
    expect(await store.sessions.get(id, 'any')).toMatchObject({ model: 'deepseek-v4-flash', reasoningEffort: 'low' })

    const second = await startProcess(store, query)
    expect(await (await fetch(`${second.origin}/v1/agents/sessions/${id}`)).json()).toMatchObject({
      agent: { model: 'deepseek-v4-flash', reasoning: { effort: 'low' } },
      metadata: { n: '1' },
    })
    expect((await fetch(`${second.origin}/v1/agents/sessions/${id}`, { method: 'POST', body: JSON.stringify({ agent: { model: '' } }) })).status).toBe(400)
  })
})

describe('MCP secrets across restart', () => {
  it('shows masked values after resume while the resumed agent mounts the real header', async () => {
    const secret = 'ck_test_secret'
    const store = new MemoryStore()
    const query = new FakeSessionQuery()
    const first = await startProcess(store, query)
    const tool = { type: 'mcp', server_label: 'composio', transport: { type: 'http', server_url: 'https://example.com/mcp', headers: { 'x-consumer-api-key': secret } } }
    const id = await createSession(first.origin, { agent: { model: 'deepseek-chat', tools: [tool] } })
    first.feed(id, logEvent('turn/start', { turn: 1 }, 1))

    const second = await startProcess(store, query)
    const cold = await (await fetch(`${second.origin}/v1/agents/sessions/${id}`)).text()
    expect(cold).not.toContain(secret)
    await second.api.resumeSession((await store.sessions.get(id, 'any'))!)
    expect(second.plugins[0]).toMatchObject({ serverName: 'composio', headers: { 'x-consumer-api-key': secret } })
    expect(await (await fetch(`${second.origin}/v1/agents/sessions/${id}`)).text()).not.toContain(secret)
    const replay = await readStream(await fetch(`${second.origin}/v1/agents/sessions/${id}/events`, { headers: { 'last-event-id': '0' } }), text => frameIds(text).length >= 1)
    expect(replay).not.toContain(secret)
  })
})
