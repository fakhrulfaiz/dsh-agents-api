/**
 * Scheduled deliveries resolve Agentry-owned sessions through the gateway, and
 * deleting a session deletes the tasks that deliver to it.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ScheduleService } from '@deepseek-ai/dsh-schedule'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { installScheduleResolver } from '../src/schedule-resolver.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { fakeLlm, fakeModel } from './support/fake-model.ts'
import { FakeSessionQuery, logEvent, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'
import { openAuthenticator } from './open-auth.ts'

const OWNER = ownerId('test')
const environments = createLocalProvider(join(tmpdir(), 'agentry-schedule-resolve-spec'))
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

interface CatalogRow {
  id: string
  target: { kind: 'session' | 'new_once'; sessionId: string } | { kind: 'new' }
  involvedSessionIds?: string[]
}

/** In-memory `catalog` and `edit` delete, recording the deleted ids. */
function fakeSchedule(rows: CatalogRow[]): { service: ScheduleService; rows: CatalogRow[]; deleted: string[]; failCatalog: boolean } {
  const state = { rows, deleted: [] as string[], failCatalog: false }
  const service = {
    deliveryLimits: () => ({ newSessionIntervalSeconds: 60 }),
    catalog: async () => {
      if (state.failCatalog) throw new Error('schedule store offline')
      return state.rows.map(row => ({ ...row, involvedSessionIds: row.involvedSessionIds ?? [] }))
    },
    edit: async (request: { id: string; action: 'delete' }) => {
      state.deleted.push(request.id)
      state.rows = state.rows.filter(row => row.id !== request.id)
      return { id: request.id, deleted: true }
    },
  }
  return Object.assign(state, { service: service as unknown as ScheduleService })
}

interface Process {
  api: AgentsGateway
  registry: SessionRegistry
  origin: string
  resume: ReturnType<typeof vi.fn<(options: ResumeAgentOptions) => Promise<unknown>>>
  /** Dispose spy of each live agent by session id. */
  disposers: Map<string, ReturnType<typeof vi.fn>>
}

/**
 * One server process over a shared index and Session log; a second call with the same `store` and `query` models a restart.
 * @param store - session index.
 * @param query - Session log.
 * @param schedule - schedule service, or none.
 */
async function startProcess(store: MemoryStore, query: FakeSessionQuery, schedule?: ScheduleService): Promise<Process> {
  const agents = new Map<string, { followup: ReturnType<typeof vi.fn> }>()
  const disposers = new Map<string, ReturnType<typeof vi.fn>>()
  const make = async (sessionId: string, setup?: (agentCtx: unknown) => Promise<void>) => {
    const agent = { followup: vi.fn(), steer: vi.fn(), cancel: vi.fn(), model: fakeModel() }
    agents.set(sessionId, agent)
    const systemPrompt = { section: () => undefined, getSectionOrder: () => 2500 }
    await setup?.({
      get: (name: string) => name === 'systemPrompt' ? systemPrompt : undefined,
      systemPrompt,
      plugin: () => Promise.resolve(),
      tools: { register: () => () => undefined, restrict: () => () => undefined, guard: () => () => undefined },
    })
    const dispose = vi.fn(() => Promise.resolve())
    disposers.set(sessionId, dispose)
    return { agent, dispose }
  }
  const resume = vi.fn<(options: ResumeAgentOptions) => Promise<unknown>>(options => make(options.resumeSessionId, options.setup as never))
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
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as Context
  const registry = new SessionRegistry()
  const options = { ...testGatewayOptions(environments, query), schedule: () => schedule }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, registry, options)
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  servers.push(server)
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  return { api, registry, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, resume, disposers }
}

/** Create a session in one process, log a turn, and restart, so the session is not live in the returned process. */
async function restartedSession(): Promise<{ id: string; store: MemoryStore; second: Process }> {
  const store = new MemoryStore()
  await store.ensureOwner(OWNER)
  const query = new FakeSessionQuery()
  const first = await startProcess(store, query)
  const { id } = await first.api.createIdleSession(OWNER, { agent: { model: 'deepseek-chat' } })
  query.append(id, logEvent('turn/start', { turn: 1 }, 1))
  query.append(id, logEvent('turn/end', { reason: { kind: 'completed' } }, 2))
  query.crash()
  return { id, store, second: await startProcess(store, query) }
}

/** A real Cordis context with the resolver installed over `api`, and a Host fallback that records its calls. */
function host(api: AgentsGateway): { resolve: (id: string) => Promise<Agent>; fallback: ReturnType<typeof vi.fn<() => Promise<Agent>>>; hostAgent: Agent } {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  installScheduleResolver(ctx, sessionId => api.agentFor(sessionId))
  const hostAgent = { id: 'host-agent' } as unknown as Agent
  const fallback = vi.fn<() => Promise<Agent>>(() => Promise.resolve(hostAgent))
  return { resolve: id => ctx.waterfall('schedule/resolve-agent', SessionId(id), fallback), fallback, hostAgent }
}

describe('schedule/resolve-agent', () => {
  it('resumes a known session that is not live and returns its live agent', async () => {
    const { id, second } = await restartedSession()
    const { resolve, fallback } = host(second.api)
    expect(second.registry.get(id)).toBeUndefined()
    const agent = await resolve(id)
    expect(second.resume).toHaveBeenCalledOnce()
    expect(second.resume.mock.calls[0]![0].resumeSessionId).toBe(id)
    expect(second.registry.get(id)).toBeDefined()
    expect(agent).toBe(await second.api.agentFor(id))
    expect(second.resume).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('calls next() for an id the API does not own', async () => {
    const { second } = await restartedSession()
    const { resolve, fallback, hostAgent } = host(second.api)
    await expect(resolve('session-host-only')).resolves.toBe(hostAgent)
    expect(fallback).toHaveBeenCalledOnce()
    expect(second.resume).not.toHaveBeenCalled()
  })

  it('rejects the delivery with session_not_resumable for a row without a stored setup', async () => {
    const store = new MemoryStore()
    await store.ensureOwner(OWNER)
    const at = new Date()
    await store.sessions.insert({ id: 'sess_legacy', dshSessionId: 'sess_legacy', ownerId: OWNER, agentId: null, environmentId: null, status: 'idle', lastError: null, model: 'deepseek-chat', reasoningEffort: null, body: null, createdAt: at, updatedAt: at })
    const process = await startProcess(store, new FakeSessionQuery())
    const { resolve, fallback } = host(process.api)
    await expect(resolve('sess_legacy')).rejects.toMatchObject({ status: 409, code: 'session_not_resumable' })
    expect(fallback).not.toHaveBeenCalled()
    expect(process.resume).not.toHaveBeenCalled()
    expect(await store.sessions.get('sess_legacy', 'any')).toBeDefined()
  })

  it('resumes once for concurrent resolves', async () => {
    const { id, second } = await restartedSession()
    const { resolve } = host(second.api)
    const agents = await Promise.all([resolve(id), resolve(id), second.api.agentFor(id)])
    expect(second.resume).toHaveBeenCalledOnce()
    expect(new Set(agents).size).toBe(1)
  })
})

describe('session delete and scheduled tasks', () => {
  it('deletes the tasks that deliver to the session and leaves the others', async () => {
    const store = new MemoryStore()
    await store.ensureOwner(OWNER)
    const schedule = fakeSchedule([])
    const process = await startProcess(store, new FakeSessionQuery(), schedule.service)
    const { id } = await process.api.createIdleSession(OWNER, { agent: { model: 'deepseek-chat' } })
    const { id: other } = await process.api.createIdleSession(OWNER, { agent: { model: 'deepseek-chat' } })
    schedule.rows = [
      { id: 'sch_mine', target: { kind: 'session', sessionId: id } },
      { id: 'sch_other', target: { kind: 'session', sessionId: other } },
      { id: 'sch_new', target: { kind: 'new' } },
      { id: 'sch_mine_2', target: { kind: 'session', sessionId: id } },
    ]
    const deleted = await fetch(`${process.origin}/v1/agents/sessions/${id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(schedule.deleted).toEqual(['sch_mine', 'sch_mine_2'])
    expect(schedule.rows.map(row => row.id)).toEqual(['sch_other', 'sch_new'])
    expect(await store.sessions.get(id, 'any')).toBeUndefined()
  })

  it('keeps the session and answers 500 when the tasks cannot be read', async () => {
    const store = new MemoryStore()
    await store.ensureOwner(OWNER)
    const schedule = fakeSchedule([])
    const process = await startProcess(store, new FakeSessionQuery(), schedule.service)
    const { id } = await process.api.createIdleSession(OWNER, { agent: { model: 'deepseek-chat' } })
    schedule.failCatalog = true
    const response = await fetch(`${process.origin}/v1/agents/sessions/${id}`, { method: 'DELETE' })
    expect(response.status).toBe(500)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('schedule_cleanup_failed')
    expect(body.error.message).not.toContain('schedule store offline')
    expect(await store.sessions.get(id, 'any')).toBeDefined()
    expect(process.registry.get(id)).toBeDefined()
  })

  it('deletes tasks that only list the session as involved', async () => {
    const store = new MemoryStore()
    await store.ensureOwner(OWNER)
    const schedule = fakeSchedule([])
    const process = await startProcess(store, new FakeSessionQuery(), schedule.service)
    const { id } = await process.api.createIdleSession(OWNER, { agent: { model: 'deepseek-chat' } })
    const { id: other } = await process.api.createIdleSession(OWNER, { agent: { model: 'deepseek-chat' } })
    schedule.rows = [
      { id: 'sch_chat_new', target: { kind: 'new' }, involvedSessionIds: [id] },
      { id: 'sch_retargeted', target: { kind: 'new_once', sessionId: 'sess_delivered' }, involvedSessionIds: [id] },
      { id: 'sch_other', target: { kind: 'new' }, involvedSessionIds: [other] },
    ]
    expect((await fetch(`${process.origin}/v1/agents/sessions/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect(schedule.deleted).toEqual(['sch_chat_new', 'sch_retargeted'])
    expect(schedule.rows.map(row => row.id)).toEqual(['sch_other'])
  })

  it('stops the live agent before it deletes the tasks', async () => {
    const store = new MemoryStore()
    await store.ensureOwner(OWNER)
    const schedule = fakeSchedule([])
    const process = await startProcess(store, new FakeSessionQuery(), schedule.service)
    const { id } = await process.api.createIdleSession(OWNER, { agent: { model: 'deepseek-chat' } })
    const order: string[] = []
    process.disposers.get(id)!.mockImplementation(() => {
      order.push('dispose')
      return Promise.resolve()
    })
    const catalog = schedule.service.catalog.bind(schedule.service)
    vi.spyOn(schedule.service, 'catalog').mockImplementation(() => {
      order.push('catalog')
      return catalog()
    })
    expect((await fetch(`${process.origin}/v1/agents/sessions/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect(order).toEqual(['dispose', 'catalog'])
  })
})
