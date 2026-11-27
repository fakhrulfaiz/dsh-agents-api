/** Session background jobs: list, retrieve and kill over DSH's `ctx.jobs`, plus the stream events. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { exitCodeOf, readTail, watchJobs, type JobEventLike, type JobRegistryLike, type JobViewLike } from '../src/jobs.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import type { SessionIndexRow } from '../src/store/store.ts'
import type { OAISessionEvent } from '../src/types.ts'
import { openAuthenticator } from './open-auth.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'
import { SpecValidator } from './support/openapi.ts'

const spec = new SpecValidator()
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

function row(id: string, owner = 'test'): SessionIndexRow {
  const now = new Date()
  return { id, ownerId: ownerId(owner), agentId: null, environmentId: null, projectId: null, dshSessionId: id, status: 'idle', lastError: null, model: 'm', reasoningEffort: null, body: null, createdAt: now, updatedAt: now }
}

interface FakeJob { view: JobViewLike & { status: JobViewLike['status'] }; chunks: Array<{ at: number; text: string }> }

/** An in-memory registry with DSH's access rules: a caller sees its own and unowned jobs. */
class FakeJobs implements JobRegistryLike {
  readonly jobs: FakeJob[] = []
  readonly listeners: Array<(event: JobEventLike) => void> = []
  readonly kills: Array<{ id: string; caller: string; reason?: string }> = []
  readonly events = {
    subscribe: (_filter: { owners: 'all' }, listener: (event: JobEventLike) => void) => {
      this.listeners.push(listener)
      return () => { this.listeners.splice(this.listeners.indexOf(listener), 1) }
    },
  }

  add(id: string, owner: string | undefined, status: JobViewLike['status'], text = '', extra: Partial<JobViewLike> = {}): FakeJob {
    const total = Buffer.byteLength(text)
    const job: FakeJob = {
      view: { id, kind: 'bash', label: `cmd ${id}`, ...owner === undefined ? {} : { owner }, status, startedAt: 1_700_000_000_500, output: { total, earliest: 0 }, ...extra },
      chunks: text === '' ? [] : [{ at: 0, text }],
    }
    this.jobs.push(job)
    return job
  }

  private visible(caller: string): FakeJob[] {
    return this.jobs.filter(job => job.view.owner === undefined || job.view.owner === caller)
  }

  private find(id: string, caller: string): FakeJob {
    const job = this.visible(caller).find(entry => entry.view.id === id)
    if (job === undefined) throw new Error('unknown job')
    return job
  }

  list(caller: string): JobViewLike[] { return this.visible(caller).map(job => ({ ...job.view })) }
  get(id: string, caller: string): JobViewLike { return { ...this.find(id, caller).view } }
  readAt(id: string, from: number, caller: string) {
    const job = this.find(id, caller)
    return { chunks: job.chunks.filter(chunk => chunk.at + Buffer.byteLength(chunk.text) > from), next: job.view.output.total, lossy: from < job.view.output.earliest }
  }

  kill(id: string, caller: string, reason?: string): 'requested' | 'already-finished' {
    const job = this.find(id, caller)
    this.kills.push({ id, caller, ...reason === undefined ? {} : { reason } })
    if (job.view.status !== 'running') return 'already-finished'
    job.view = { ...job.view, status: 'stopping' }
    return 'requested'
  }
}

async function start(jobs: FakeJobs | undefined) {
  const store = new MemoryStore()
  await store.ensureOwner(ownerId('test'))
  await store.ensureOwner(ownerId('other'))
  await store.sessions.insert(row('sess_a'))
  await store.sessions.insert(row('sess_b', 'other'))
  const ctx = { logger: { warn: vi.fn(), info: vi.fn() }, get: () => undefined } as unknown as Context
  const options = { ...testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-jobs-spec-envs')), new FakeSessionQuery()), jobs: () => jobs }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, new SessionRegistry(), options)
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  async function call(method: string, template: string, params: Record<string, string>, body: unknown, expected: number): Promise<any> {
    const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? '')
    if (body !== undefined) expect(spec.request(method, template, body)).toEqual([])
    const res = await fetch(origin + path, {
      method,
      headers: { 'openai-beta': 'agents=v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    expect(res.status).toBe(expected)
    const parsed = await res.json() as unknown
    expect(spec.response(method, template, res.status, parsed), `${method} ${template} -> ${String(res.status)}`).toEqual([])
    return parsed
  }
  return { call }
}

const LIST = '/v1/agents/sessions/{session_id}/jobs'
const ONE = '/v1/agents/sessions/{session_id}/jobs/{job_id}'
const KILL = '/v1/agents/sessions/{session_id}/jobs/{job_id}/kill'

describe('session jobs routes', () => {
  it('lists only the session\'s own jobs, with output and exit codes', async () => {
    const jobs = new FakeJobs()
    jobs.add('bash-1', 'sess_a', 'running', 'building...\n')
    jobs.add('bash-2', 'sess_a', 'completed', 'done\n', { detail: 'exit code: 2', finishedAt: 1_700_000_003_900 })
    jobs.add('bash-3', undefined, 'running', 'unowned')
    jobs.add('bash-4', 'sess_b', 'running', 'theirs')
    const { call } = await start(jobs)
    const list = await call('GET', LIST, { session_id: 'sess_a' }, undefined, 200)
    expect(list).toEqual({
      object: 'list',
      data: [
        { id: 'bash-1', object: 'agent.session.job', session_id: 'sess_a', kind: 'bash', command: 'cmd bash-1', status: 'running', detail: null, exit_code: null, started_at: 1_700_000_000, finished_at: null, output: { text: 'building...\n', total_bytes: 12, truncated: false } },
        { id: 'bash-2', object: 'agent.session.job', session_id: 'sess_a', kind: 'bash', command: 'cmd bash-2', status: 'completed', detail: 'exit code: 2', exit_code: 2, started_at: 1_700_000_000, finished_at: 1_700_000_003, output: { text: 'done\n', total_bytes: 5, truncated: false } },
      ],
    })
    expect((await call('GET', ONE, { session_id: 'sess_a', job_id: 'bash-2' }, undefined, 200)).id).toBe('bash-2')
    await call('GET', ONE, { session_id: 'sess_a', job_id: 'bash-3' }, undefined, 404)
    await call('GET', ONE, { session_id: 'sess_a', job_id: 'bash-4' }, undefined, 404)
  })

  it('hides another owner\'s session and answers an empty list without a registry', async () => {
    const jobs = new FakeJobs()
    jobs.add('bash-4', 'sess_b', 'running')
    const { call } = await start(jobs)
    await call('GET', LIST, { session_id: 'sess_b' }, undefined, 404)
    await call('GET', ONE, { session_id: 'sess_b', job_id: 'bash-4' }, undefined, 404)
    await call('POST', KILL, { session_id: 'sess_b', job_id: 'bash-4' }, undefined, 404)
    expect(jobs.kills).toEqual([])
    const bare = await start(undefined)
    expect(await bare.call('GET', LIST, { session_id: 'sess_a' }, undefined, 200)).toEqual({ object: 'list', data: [] })
    await bare.call('POST', KILL, { session_id: 'sess_a', job_id: 'bash-1' }, undefined, 404)
  })

  it('kills a running job with the user\'s reason, and reports a finished one', async () => {
    const jobs = new FakeJobs()
    jobs.add('bash-1', 'sess_a', 'running')
    jobs.add('bash-2', 'sess_a', 'completed', '', { detail: 'exit code: 0' })
    jobs.add('bash-3', undefined, 'running')
    const { call } = await start(jobs)
    const killed = await call('POST', KILL, { session_id: 'sess_a', job_id: 'bash-1' }, undefined, 200)
    expect(killed).toMatchObject({ outcome: 'cancellation_requested', job: { id: 'bash-1', status: 'stopping' } })
    expect(killed.job.output).toBeUndefined()
    expect(jobs.kills[0]).toEqual({ id: 'bash-1', caller: 'sess_a', reason: 'stopped by the user' })
    await call('POST', KILL, { session_id: 'sess_a', job_id: 'bash-2' }, { reason: '  not needed ' }, 200)
      .then(body => { expect(body.outcome).toBe('already_finished') })
    expect(jobs.kills[1]?.reason).toBe('not needed')
    await call('POST', KILL, { session_id: 'sess_a', job_id: 'bash-3' }, undefined, 404)
    await call('POST', KILL, { session_id: 'sess_a', job_id: 'nope' }, undefined, 404)
  })
})

describe('job output and events', () => {
  it('keeps the newest bytes, on a character boundary', () => {
    const jobs = new FakeJobs()
    const text = `${'a'.repeat(10)}é${'b'.repeat(5)}`
    const job = jobs.add('bash-1', 'sess_a', 'running', text)
    expect(readTail(jobs, job.view, 'sess_a', 100)).toEqual({ text, total_bytes: 17, truncated: false })
    // 6 bytes from the end cuts inside "é"; its continuation byte is dropped.
    expect(readTail(jobs, job.view, 'sess_a', 6)).toEqual({ text: 'bbbbb', total_bytes: 17, truncated: true })
    job.view = { ...job.view, output: { total: 17, earliest: 4 } }
    expect(readTail(jobs, job.view, 'sess_a', 100).truncated).toBe(true)
  })

  it('parses exit codes of completed jobs only', () => {
    expect(exitCodeOf({ status: 'completed', detail: 'exit code: 0' })).toBe(0)
    expect(exitCodeOf({ status: 'completed', detail: 'exit code: 127; [sandbox: ...]' })).toBe(127)
    expect(exitCodeOf({ status: 'killed', detail: 'signal: SIGTERM' })).toBeNull()
    expect(exitCodeOf({ status: 'running' })).toBeNull()
  })

  it('announces owned job changes on the session stream, not output or unowned jobs', () => {
    const jobs = new FakeJobs()
    const emitted: Array<[string, OAISessionEvent]> = []
    const stop = watchJobs(jobs, (id, event) => { emitted.push([id, event]) }, () => 'evt_1')
    const owned = jobs.add('bash-1', 'sess_a', 'running').view
    const emit = (event: JobEventLike): void => { for (const listener of jobs.listeners) listener(event) }
    emit({ type: 'registered', job: owned })
    emit({ type: 'output', id: 'bash-1', owner: 'sess_a', total: 4 })
    emit({ type: 'settled', job: { ...owned, status: 'completed', detail: 'exit code: 0', finishedAt: 1_700_000_001_000 } })
    emit({ type: 'removed', job: owned })
    emit({ type: 'registered', job: jobs.add('bash-2', undefined, 'running').view })
    expect(emitted.map(([id, event]) => [id, event.type])).toEqual([
      ['sess_a', 'agent.session.job.updated'],
      ['sess_a', 'agent.session.job.updated'],
      ['sess_a', 'agent.session.job.removed'],
    ])
    for (const [, event] of emitted) expect(spec.schema('SessionEvent', event), event.type).toEqual([])
    expect(emitted[1]?.[1]).toMatchObject({ job: { status: 'completed', exit_code: 0, finished_at: 1_700_000_001 } })
    stop()
    expect(jobs.listeners).toEqual([])
  })
})
