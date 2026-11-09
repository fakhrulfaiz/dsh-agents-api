/**
 * `/v1/agents/schedules`: owner scoping, session provisioning, error mapping,
 * pagination, and the wire form of timing.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ownerId, type Authenticator } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { mapScheduleError, ownerOf, toWireTiming } from '../src/schedules.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { fakeLlm, fakeModel } from './support/fake-model.ts'
import { FakeSchedule, inputError, recordFor } from './support/fake-schedule.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'
import type { ScheduleRecord, ScheduleTiming as DshTiming } from '@deepseek-ai/dsh-schedule'

const ALICE = ownerId('alice')
const BOB = ownerId('bob')
const environments = createLocalProvider(join(tmpdir(), 'agentry-schedules-spec'))
const servers: Server[] = []

/** Authenticates every request as the owner named by `x-owner`. */
const ownerHeader: Authenticator = {
  authenticate: req => Promise.resolve({
    ok: true as const,
    principal: { owner: ownerId(String(req.headers['x-owner'] ?? 'alice')), roles: new Set(['agentry-user' as const]) },
  }),
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

/** A gateway over a fake context, a memory store, and a fake schedule service. */
async function start(options: { schedule?: boolean; failCreate?: boolean } = {}) {
  const live = new Map<string, { dispose: ReturnType<typeof vi.fn> }>()
  const ctx = {
    agents: {
      create: ({ sessionId }: { sessionId: string }) => {
        if (options.failCreate === true) return Promise.reject(new Error('postgres://internal-host failed'))
        const dispose = vi.fn(() => Promise.resolve())
        live.set(sessionId, { dispose })
        return Promise.resolve({ agent: { followup: vi.fn(), steer: vi.fn(), cancel: vi.fn(), model: fakeModel() }, dispose })
      },
      get: () => undefined,
    },
    sessions: { get: () => undefined },
    llm: fakeLlm(),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    tools: { schemas: () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  } as unknown as Context
  const store = new MemoryStore()
  const fake = new FakeSchedule()
  const registry = new SessionRegistry()
  const gatewayOptions = { ...testGatewayOptions(environments, new FakeSessionQuery()), schedule: () => options.schedule === false ? undefined : fake.asService() }
  const api = new AgentsGateway(ctx, ownerHeader, '/v1', store, registry, gatewayOptions)
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  /** Send a request as `owner`; the body is JSON when given. */
  async function call(owner: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${origin}/v1${path}`, {
      method,
      headers: { 'x-owner': owner, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: await res.json() }
  }

  /** A session owned by `owner`, as the chat the agent would create tasks from. */
  async function chat(owner: typeof ALICE): Promise<string> {
    await store.ensureOwner(owner)
    return (await api.createIdleSession(owner, { agent: { model: 'deepseek-chat' } })).id
  }

  return { api, store, fake, registry, live, call, chat, ctx }
}

const DAILY = { kind: 'daily', daily: { time: '08:00', time_zone: 'Asia/Kuala_Lumpur' } } as const
const CREATE = { title: 'Morning brief', prompt: 'Summarize the news', timing: DAILY, agent: { model: 'deepseek-chat' } }

describe('POST /agents/schedules', () => {
  it('answers a generic 500 and logs the detail when the session cannot be created', async () => {
    const { call, ctx } = await start({ failCreate: true })
    const { status, body } = await call('alice', 'POST', '/agents/schedules', CREATE)
    expect(status).toBe(500)
    expect(body.error.code).toBe('agent_create_failed')
    expect(JSON.stringify(body)).not.toContain('internal-host')
    expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.join('\n')).toContain('internal-host')
  })

  it('provisions a session and creates the task against it with the session as actor', async () => {
    const { call, fake, store } = await start()
    const { status, body } = await call('alice', 'POST', '/agents/schedules', CREATE)
    expect(status).toBe(200)
    const created = fake.calls.find(entry => entry.method === 'create')!
    const request = created.args[0] as { title: string; prompt: string; timing: unknown; target: { kind: string; sessionId: string } }
    expect(request).toMatchObject({ title: 'Morning brief', prompt: 'Summarize the news', timing: DAILY, target: { kind: 'session' } })
    expect(created.args[1]).toBe(request.target.sessionId)
    const row = await store.sessions.get(request.target.sessionId, ALICE)
    expect(row).toMatchObject({ status: 'idle', ownerId: ALICE })
    expect(row?.body?.metadata).toEqual({ title: 'Morning brief', source: 'schedule' })
    expect(body).toMatchObject({
      object: 'agent.schedule',
      title: 'Morning brief',
      session_id: request.target.sessionId,
      status: 'active',
      next_run_at: '2026-11-11T08:00:00.000Z',
      timing: { kind: 'daily', daily: { time: '08:00:00.000', time_zone: 'Asia/Kuala_Lumpur' } },
      running: false,
      last_run: null,
    })
    expect(body.revision).toBe(body.updated_at)
  })

  it('targets the caller\'s own session without provisioning another', async () => {
    const { call, fake, chat, store } = await start()
    const mine = await chat(ALICE)
    const { status, body } = await call('alice', 'POST', '/agents/schedules', { title: 'T', prompt: 'P', timing: DAILY, session_id: mine })
    expect(status).toBe(200)
    expect(body.session_id).toBe(mine)
    expect((await store.sessions.list({ owner: ALICE, limit: 10 })).data).toHaveLength(1)
    expect(fake.calls.find(entry => entry.method === 'create')!.args[1]).toBe(mine)
  })

  it('answers 404 for another owner\'s session_id and creates nothing', async () => {
    const { call, fake, chat } = await start()
    const bobs = await chat(BOB)
    const { status, body } = await call('alice', 'POST', '/agents/schedules', { title: 'T', prompt: 'P', timing: DAILY, session_id: bobs })
    expect(status).toBe(404)
    expect(body.error.code).toBe('resource_not_found')
    expect(fake.mutatingCalls()).toEqual([])
  })

  it('answers 400 with the Host code for rejected timing', async () => {
    const { call, fake } = await start()
    fake.createError = inputError('invalid_time_zone')
    const { status, body } = await call('alice', 'POST', '/agents/schedules', CREATE)
    expect(status).toBe(400)
    expect(body.error.code).toBe('invalid_time_zone')
  })

  it('deletes the provisioned session when the Host rejects the task', async () => {
    const { call, fake, store, live, registry } = await start()
    fake.createError = inputError('not_future')
    await call('alice', 'POST', '/agents/schedules', CREATE)
    expect((await store.sessions.list({ owner: ALICE, limit: 10 })).data).toEqual([])
    const [created] = [...live.entries()]
    expect(created).toBeDefined()
    const [id, handle] = created!
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(registry.get(id)).toBeUndefined()
  })

  it('keeps a session the caller supplied when the Host rejects the task', async () => {
    const { call, fake, chat, store } = await start()
    const mine = await chat(ALICE)
    fake.createError = inputError('invalid_rule')
    expect((await call('alice', 'POST', '/agents/schedules', { title: 'T', prompt: 'P', timing: DAILY, session_id: mine })).status).toBe(400)
    expect(await store.sessions.get(mine, ALICE)).toBeDefined()
  })

  it.each([
    ['a missing title', { ...CREATE, title: undefined }],
    ['a title over 120 characters', { ...CREATE, title: 'x'.repeat(121) }],
    ['a blank prompt', { ...CREATE, prompt: '   ' }],
    ['a non-object timing', { ...CREATE, timing: 'daily' }],
    ['an unknown timing kind', { ...CREATE, timing: { kind: 'monthly' } }],
    ['a non-string session_id', { ...CREATE, session_id: 7 }],
  ])('answers 400 for %s before creating a session', async (_name, body) => {
    const { call, fake, store } = await start()
    const { status, body: error } = await call('alice', 'POST', '/agents/schedules', body)
    expect(status).toBe(400)
    expect(error.error.code).toBe('bad_request')
    expect(fake.calls).toEqual([])
    expect((await store.sessions.list({ owner: ALICE, limit: 10 })).data).toEqual([])
  })

  it('answers 400 from session provisioning when no agent is given', async () => {
    const { call, fake } = await start()
    const { status } = await call('alice', 'POST', '/agents/schedules', { title: 'T', prompt: 'P', timing: DAILY })
    expect(status).toBe(400)
    expect(fake.calls).toEqual([])
  })

  it('answers 409 schedule_target_archived when the Host reports an archived target', async () => {
    const { call, fake } = await start()
    fake.createError = new RemoteError('schedule/target-archived', 'archived', { sessionId: SessionId('x') })
    const { status, body } = await call('alice', 'POST', '/agents/schedules', CREATE)
    expect(status).toBe(409)
    expect(body.error.code).toBe('schedule_target_archived')
  })
})

describe('owner scoping', () => {
  it('lists only the caller\'s tasks, including a chat-created one known by involved sessions', async () => {
    const { call, fake, chat } = await start()
    const aliceChat = await chat(ALICE)
    const bobChat = await chat(BOB)
    fake.add({ id: 'sch_rest', target: { kind: 'session', sessionId: aliceChat } })
    fake.add({ id: 'sch_chat', target: { kind: 'new_once', sessionId: 'session-reserved', create: {} }, involvedSessionIds: [aliceChat] })
    fake.add({ id: 'sch_bob', target: { kind: 'session', sessionId: bobChat } })
    fake.add({ id: 'sch_orphan', target: { kind: 'session', sessionId: 'session-host-only' } })
    const { body } = await call('alice', 'GET', '/agents/schedules')
    expect(body.data.map((item: { id: string }) => item.id)).toEqual(['sch_rest', 'sch_chat'])
    expect(body.data[1].session_id).toBe(aliceChat)
    expect((await call('bob', 'GET', '/agents/schedules')).body.data.map((item: { id: string }) => item.id)).toEqual(['sch_bob'])
  })

  it('prefers the target session over involved sessions when deciding the owner', async () => {
    const { chat, fake } = await start()
    const aliceChat = await chat(ALICE)
    const bobChat = await chat(BOB)
    const entry = fake.add({ id: 'sch_mixed', target: { kind: 'session', sessionId: bobChat }, involvedSessionIds: [aliceChat] })
    expect(ownerOf(entry, new Map([[aliceChat, ALICE], [bobChat, BOB]]))).toEqual({ owner: BOB, sessionId: bobChat })
  })

  it.each([
    ['get', 'GET', '', undefined],
    ['update', 'POST', '', { title: 'Hijacked' }],
    ['delete', 'DELETE', '', undefined],
    ['pause', 'POST', '/pause', undefined],
    ['resume', 'POST', '/resume', undefined],
    ['run', 'POST', '/run', undefined],
    ['runs', 'GET', '/runs', undefined],
  ])('answers 404 for another owner\'s task on %s and never mutates', async (_name, method, suffix, body) => {
    const { call, fake, chat } = await start()
    const bobChat = await chat(BOB)
    fake.add({ id: 'sch_bob', target: { kind: 'session', sessionId: bobChat } })
    const { status, body: error } = await call('alice', method, `/agents/schedules/sch_bob${suffix}`, body)
    expect(status).toBe(404)
    expect(error.error.code).toBe('schedule_not_found')
    expect(fake.mutatingCalls()).toEqual([])
    expect(fake.calls.some(entry => entry.method === 'history')).toBe(false)
    expect(fake.entries).toHaveLength(1)
  })

  it('answers 404 for a task whose sessions are not indexed', async () => {
    const { call, fake } = await start()
    fake.add({ id: 'sch_host', target: { kind: 'session', sessionId: 'session-host-only' } })
    expect((await call('alice', 'GET', '/agents/schedules/sch_host')).status).toBe(404)
    expect(fake.mutatingCalls()).toEqual([])
  })

  it('answers 404 for an unknown id', async () => {
    const { call } = await start()
    const { status, body } = await call('alice', 'GET', '/agents/schedules/nope')
    expect(status).toBe(404)
    expect(body.error.code).toBe('schedule_not_found')
  })
})

describe('owned task routes', () => {
  async function owned() {
    const env = await start()
    const sessionId = await env.chat(ALICE)
    env.fake.add({ id: 'sch_1', target: { kind: 'session', sessionId: sessionId } })
    return { ...env, sessionId }
  }

  it('retrieves a task', async () => {
    const { call, sessionId } = await owned()
    const { status, body } = await call('alice', 'GET', '/agents/schedules/sch_1')
    expect(status).toBe(200)
    expect(body).toMatchObject({ id: 'sch_1', session_id: sessionId, created_at: '2026-11-09T00:00:00.000Z', revision: '2026-11-09T00:00:00.000Z' })
  })

  it('updates fields and passes the revision as the expected version', async () => {
    const { call, fake } = await owned()
    const { status, body } = await call('alice', 'POST', '/agents/schedules/sch_1', { title: 'New', prompt: ' Do more ', revision: '2026-11-09T00:00:00.000Z' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ title: 'New', prompt: 'Do more' })
    expect(body.revision).not.toBe('2026-11-09T00:00:00.000Z')
    expect(fake.calls.find(entry => entry.method === 'edit')!.args[0]).toMatchObject({ action: 'update', patch: { title: 'New', prompt: 'Do more' }, expectedUpdatedAt: '2026-11-09T00:00:00.000Z' })
  })

  it('answers 409 schedule_conflict for a stale revision and leaves the task unchanged', async () => {
    const { call, fake } = await owned()
    const { status, body } = await call('alice', 'POST', '/agents/schedules/sch_1', { title: 'New', revision: '2020-01-01T00:00:00.000Z' })
    expect(status).toBe(409)
    expect(body.error.code).toBe('schedule_conflict')
    expect(fake.entries[0]!.title).toBe('Task')
  })

  it('answers 400 for an empty update and for a non-string revision', async () => {
    const { call, fake } = await owned()
    expect((await call('alice', 'POST', '/agents/schedules/sch_1', { revision: '2026-11-09T00:00:00.000Z' })).status).toBe(400)
    expect((await call('alice', 'POST', '/agents/schedules/sch_1', { title: 'x', revision: 3 })).status).toBe(400)
    expect((await call('alice', 'POST', '/agents/schedules/sch_1', { title: '' })).status).toBe(400)
    expect(fake.mutatingCalls()).toEqual([])
  })

  it('maps Host input errors on update to 400', async () => {
    const { call, fake } = await owned()
    const edit = fake.service.edit
    fake.service.edit = () => Promise.reject(inputError('invalid_rule'))
    const { status, body } = await call('alice', 'POST', '/agents/schedules/sch_1', { timing: { kind: 'every', every_seconds: 1 } })
    fake.service.edit = edit
    expect(status).toBe(400)
    expect(body.error.code).toBe('invalid_rule')
  })

  it('deletes a task and keeps its session', async () => {
    const { call, fake, store, sessionId } = await owned()
    const { status, body } = await call('alice', 'DELETE', '/agents/schedules/sch_1')
    expect(status).toBe(200)
    expect(body).toEqual({ id: 'sch_1', object: 'agent.schedule.deleted', deleted: true })
    expect(fake.entries).toEqual([])
    expect(await store.sessions.get(sessionId, ALICE)).toBeDefined()
  })

  it('passes the read revision as expectedUpdatedAt on delete, pause, and resume', async () => {
    const { call, fake } = await owned()
    await call('alice', 'POST', '/agents/schedules/sch_1/pause')
    const revision = fake.entries[0]!.updatedAt
    await call('alice', 'POST', '/agents/schedules/sch_1/resume')
    const revision2 = fake.entries[0]!.updatedAt
    await call('alice', 'DELETE', '/agents/schedules/sch_1')
    const edits = fake.calls.filter(entry => entry.method === 'edit').map(entry => entry.args[0])
    expect(edits[0]).toMatchObject({ expectedUpdatedAt: '2026-11-09T00:00:00.000Z' })
    expect(edits[1]).toMatchObject({ expectedUpdatedAt: revision })
    expect(edits[2]).toMatchObject({ expectedUpdatedAt: revision2 })
  })

  it.each([
    ['delete', 'DELETE', ''],
    ['pause', 'POST', '/pause'],
    ['resume', 'POST', '/resume'],
  ])('answers 409 schedule_conflict when the task changes between the ownership read and %s', async (_name, method, suffix) => {
    const { call, fake } = await owned()
    const view = fake.service.view
    fake.service.view = async (request: { id: string }) => {
      const seen = await view(request)
      fake.entries[0] = { ...fake.entries[0]!, title: 'Changed elsewhere', updatedAt: '2026-11-09T01:00:00.000Z' }
      return seen
    }
    const { status, body } = await call('alice', method, `/agents/schedules/sch_1${suffix}`)
    expect(status).toBe(409)
    expect(body.error.code).toBe('schedule_conflict')
    expect(fake.entries).toHaveLength(1)
    expect(fake.entries[0]!.title).toBe('Changed elsewhere')
  })

  it('pauses and resumes', async () => {
    const { call } = await owned()
    const paused = await call('alice', 'POST', '/agents/schedules/sch_1/pause')
    expect(paused.body).toMatchObject({ status: 'paused', next_run_at: null })
    const resumed = await call('alice', 'POST', '/agents/schedules/sch_1/resume')
    expect(resumed.body).toMatchObject({ status: 'active', next_run_at: '2026-11-11T08:00:00.000Z' })
  })

  it('answers 400 not_future when resume finds no future occurrence', async () => {
    const { call, fake } = await owned()
    fake.service.edit = () => Promise.reject(inputError('not_future'))
    const { status, body } = await call('alice', 'POST', '/agents/schedules/sch_1/resume')
    expect(status).toBe(400)
    expect(body.error.code).toBe('not_future')
  })

  it('runs now and answers the task', async () => {
    const { call, fake } = await owned()
    const { status, body } = await call('alice', 'POST', '/agents/schedules/sch_1/run')
    expect(status).toBe(200)
    expect(body.id).toBe('sch_1')
    expect(fake.calls.filter(entry => entry.method === 'run')).toHaveLength(1)
  })

  it('answers 409 schedule_execution_pending while a run is active', async () => {
    const { call, fake } = await owned()
    fake.runPending = true
    const { status, body } = await call('alice', 'POST', '/agents/schedules/sch_1/run')
    expect(status).toBe(409)
    expect(body.error.code).toBe('schedule_execution_pending')
  })

  it('answers 409 schedule_target_archived when the target session is archived', async () => {
    const { call, fake } = await owned()
    fake.runError = new RemoteError('schedule/target-archived', 'archived', { sessionId: SessionId('x') })
    const { status, body } = await call('alice', 'POST', '/agents/schedules/sch_1/run')
    expect(status).toBe(409)
    expect(body.error.code).toBe('schedule_target_archived')
  })

  it('reports a run in progress and the last delivery', async () => {
    const { call, fake, sessionId } = await owned()
    Object.assign(fake.entries[0]!, {
      executionActive: true,
      lastDelivery: { scheduledAt: '2026-11-10T08:00:00.000Z', deliveredAt: '2026-11-10T08:00:01.000Z', messageId: 'msg_1', targetSessionId: sessionId },
    })
    const { body } = await call('alice', 'GET', '/agents/schedules/sch_1')
    expect(body.running).toBe(true)
    expect(body.last_run).toEqual({ scheduled_at: '2026-11-10T08:00:00.000Z', delivered_at: '2026-11-10T08:00:01.000Z', message_id: 'msg_1', session_id: sessionId })
  })

  it('pages deliveries newest first with next_before', async () => {
    const { call, fake, sessionId } = await owned()
    fake.deliveries.set('sch_1', ['c', 'b', 'a'].map(name => ({ scheduledAt: `2026-11-1${name === 'c' ? 3 : name === 'b' ? 2 : 1}T08:00:00.000Z`, deliveredAt: `2026-11-1${name === 'c' ? 3 : name === 'b' ? 2 : 1}T08:00:01.000Z`, messageId: `msg_${name}`, targetSessionId: sessionId })))
    const first = await call('alice', 'GET', '/agents/schedules/sch_1/runs?limit=2')
    expect(first.body).toMatchObject({ object: 'list', has_more: true, next_before: 'msg_b' })
    expect(first.body.data.map((run: { message_id: string }) => run.message_id)).toEqual(['msg_c', 'msg_b'])
    const second = await call('alice', 'GET', '/agents/schedules/sch_1/runs?limit=2&before=msg_b')
    expect(second.body).toMatchObject({ has_more: false, next_before: null })
    expect(second.body.data).toEqual([{ scheduled_at: '2026-11-11T08:00:00.000Z', delivered_at: '2026-11-11T08:00:01.000Z', message_id: 'msg_a', session_id: sessionId }])
  })

  it('answers 400 for a runs cursor that names no delivery', async () => {
    const { call } = await owned()
    const { status, body } = await call('alice', 'GET', '/agents/schedules/sch_1/runs?before=missing')
    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
  })
})

describe('GET /agents/schedules pagination and filter', () => {
  async function many() {
    const env = await start()
    const sessionId = await env.chat(ALICE)
    for (const [index, status] of (['active', 'active', 'paused', 'ended', 'active'] as const).entries()) {
      env.fake.add({ id: `sch_${String(index)}`, status, target: { kind: 'session', sessionId: sessionId } })
    }
    return env
  }
  const ids = (body: { data: Array<{ id: string }> }): string[] => body.data.map(item => item.id)

  it('pages with limit and after and reports has_more', async () => {
    const { call } = await many()
    const first = (await call('alice', 'GET', '/agents/schedules?limit=2')).body
    expect(ids(first)).toEqual(['sch_0', 'sch_1'])
    expect(first).toMatchObject({ object: 'list', has_more: true, first_id: 'sch_0', last_id: 'sch_1' })
    const second = (await call('alice', 'GET', '/agents/schedules?limit=2&after=sch_1')).body
    expect(ids(second)).toEqual(['sch_2', 'sch_3'])
    expect(second.has_more).toBe(true)
    const last = (await call('alice', 'GET', '/agents/schedules?limit=2&after=sch_3')).body
    expect(ids(last)).toEqual(['sch_4'])
    expect(last.has_more).toBe(false)
  })

  it('filters by status before paging', async () => {
    const { call } = await many()
    expect(ids((await call('alice', 'GET', '/agents/schedules?status=active')).body)).toEqual(['sch_0', 'sch_1', 'sch_4'])
    expect(ids((await call('alice', 'GET', '/agents/schedules?status=paused')).body)).toEqual(['sch_2'])
    const paged = (await call('alice', 'GET', '/agents/schedules?status=active&limit=2')).body
    expect(paged.has_more).toBe(true)
  })

  it('answers 400 for an unknown status', async () => {
    const { call } = await many()
    expect((await call('alice', 'GET', '/agents/schedules?status=done')).status).toBe(400)
  })

  it('answers an empty list when the caller has no tasks', async () => {
    const { call } = await many()
    expect((await call('bob', 'GET', '/agents/schedules')).body).toEqual({ object: 'list', data: [], first_id: null, last_id: null, has_more: false })
  })
})

describe('toWireTiming', () => {
  const at = '2026-11-12T07:00:00.000Z'
  it.each<[string, DshTiming, unknown]>([
    ['after', { kind: 'after', after_seconds: 90 }, { kind: 'after', after_seconds: 90 }],
    ['at', { kind: 'at', at }, { kind: 'at', at }],
    ['every', { kind: 'every', every_seconds: 3600 }, { kind: 'every', every_seconds: 3600 }],
    ['daily', { kind: 'daily', daily: { time: '8:00', time_zone: 'UTC' } }, { kind: 'daily', daily: { time: '08:00:00.000', time_zone: 'UTC' } }],
    ['weekly', { kind: 'weekly', weekly: { time: '16:30:15', time_zone: 'Europe/Paris', weekdays: [1, 5] } }, { kind: 'weekly', weekly: { time: '16:30:15.000', time_zone: 'Europe/Paris', weekdays: [1, 5] } }],
    ['cron', { kind: 'cron', cron: { expression: '0 9 * * 1', time_zone: 'UTC' } }, { kind: 'cron', cron: { expression: '0 9 * * 1', time_zone: 'UTC' } }],
    ['rrule', { kind: 'rrule', rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY' }, { kind: 'rrule', rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY' }],
  ])('%s round-trips from the stored rule', (_name, timing, wire) => {
    const normalized = timing.kind === 'daily' ? { ...timing, daily: { ...timing.daily, time: '08' } } : timing
    const record: ScheduleRecord = recordFor('id', 'T', 'P', normalized, at)
    expect(toWireTiming(record)).toEqual(wire)
  })
})

describe('mapScheduleError', () => {
  it('classifies Host input errors, remote input errors, and ignores the rest', () => {
    expect(mapScheduleError(inputError('frequency_too_high'))).toMatchObject({ status: 400, code: 'frequency_too_high' })
    expect(mapScheduleError(new RemoteError('schedule/input-invalid', 'bad', { code: 'invalid_rule' }))).toMatchObject({ status: 400, code: 'invalid_rule' })
    expect(mapScheduleError(new Error('boom'))).toBeUndefined()
    expect(mapScheduleError('boom')).toBeUndefined()
  })
})

describe('without the schedule service', () => {
  it.each([
    ['POST', '/agents/schedules', CREATE],
    ['GET', '/agents/schedules', undefined],
    ['GET', '/agents/schedules/x', undefined],
    ['POST', '/agents/schedules/x', { title: 'T' }],
    ['DELETE', '/agents/schedules/x', undefined],
    ['POST', '/agents/schedules/x/pause', undefined],
    ['POST', '/agents/schedules/x/resume', undefined],
    ['POST', '/agents/schedules/x/run', undefined],
    ['GET', '/agents/schedules/x/runs', undefined],
  ])('answers 501 schedules_unavailable for %s %s', async (method, path, body) => {
    const { call, store } = await start({ schedule: false })
    const { status, body: error } = await call('alice', method, path, body)
    expect(status).toBe(501)
    expect(error.error.code).toBe('schedules_unavailable')
    expect((await store.sessions.list({ owner: ALICE, limit: 10 })).data).toEqual([])
  })
})

describe('route order', () => {
  it('does not read "schedules" as an agent id', async () => {
    const { call } = await start()
    const { body } = await call('alice', 'GET', '/agents/schedules')
    expect(body.object).toBe('list')
  })
})
