/**
 * `GET /v1/agents/skills`: mapping, caching, validators, and failures.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillSummary, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { matchesEtag } from '../src/skills.ts'
import { ownerId } from '../src/auth/authenticator.ts'
import type { SessionIndexRow } from '../src/store/store.ts'
import { openAuthenticator } from './open-auth.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'
import { Config } from '../src/index.ts'

const servers: Server[] = []
const environments = createLocalProvider(join(tmpdir(), 'agentry-skills-spec'))

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

/** A summary with the fields the route reads. */
function summary(name: string, description = `${name} skill`, source = 'user-dsh'): SkillSummary {
  return { name, description, source, provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } }
}

/** Scope key `acquireScope()` returns in the stub preset service. */
const DEFAULT_SCOPE = { name: 'default-preset-scope' }
/** Live agent object of session `sess_live` (the agent is its own scope key). */
const LIVE_AGENT = { name: 'live-agent' }

/** Session index row owned by `owner`. */
function row(id: string, owner = 'test'): SessionIndexRow {
  const now = new Date()
  return { id, ownerId: ownerId(owner), agentId: null, environmentId: null, dshSessionId: id, status: 'idle', lastError: null, model: 'm', reasoningEffort: null, body: null, createdAt: now, updatedAt: now }
}

/** A gateway over a skill service stub; `list` is the stub's single method. */
async function start(list: ((options?: SkillViewOptions) => Promise<readonly SkillSummary[]>) | undefined, ttlMs = 60_000) {
  const warn = vi.fn()
  const released = vi.fn()
  const store = new MemoryStore()
  await store.ensureOwner(ownerId('test'))
  await store.ensureOwner(ownerId('other'))
  const workspacesRoot = join(tmpdir(), `agentry-skills-ws-${String(process.pid)}-${String(Math.random()).slice(2)}`)
  const ctx = {
    logger: { warn },
    get: (name: string) => name === 'agentPresets'
      ? { acquireScope: () => Promise.resolve({ key: DEFAULT_SCOPE, [Symbol.asyncDispose]: () => { released(); return Promise.resolve() } }) }
      : undefined,
    agents: { get: (id: string) => id === 'sess_live' ? LIVE_AGENT : undefined },
  } as unknown as Context
  const base = testGatewayOptions(environments, new FakeSessionQuery())
  const options = { ...base, workspacesRoot, skills: () => list === undefined ? undefined : { list }, skillsTtlMs: ttlMs }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, new SessionRegistry(), options)
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/skills`
  return { url, warn, store, released, workspacesRoot }
}

describe('GET /v1/agents/skills', () => {
  it('maps summaries and sorts by name', async () => {
    const { url } = await start(() => Promise.resolve([summary('zeta', 'Last', 'bundled'), summary('alpha', 'First', 'project-agents')]))
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate')
    expect(await res.json()).toEqual({
      object: 'list',
      data: [
        { name: 'alpha', description: 'First', source: 'project-agents' },
        { name: 'zeta', description: 'Last', source: 'bundled' },
      ],
    })
  })

  it('is not captured by /agents/:agent_id', async () => {
    const { url } = await start(() => Promise.resolve([]))
    expect((await fetch(url)).status).toBe(200)
  })

  it('answers an empty list without the skill service', async () => {
    const { url } = await start(undefined)
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ object: 'list', data: [] })
  })

  it('serves a cache hit within the TTL from one list call', async () => {
    const list = vi.fn(() => Promise.resolve([summary('a')]))
    const { url } = await start(list)
    await fetch(url)
    await fetch(url)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('calls list again once the TTL passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const list = vi.fn(() => Promise.resolve([summary('a')]))
      const { url } = await start(list, 1000)
      await fetch(url)
      vi.setSystemTime(Date.now() + 1500)
      await fetch(url)
      expect(list).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not cache with a zero TTL', async () => {
    const list = vi.fn(() => Promise.resolve([summary('a')]))
    const { url } = await start(list, 0)
    await fetch(url)
    await fetch(url)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight call between concurrent misses', async () => {
    let release: (value: readonly SkillSummary[]) => void = () => {}
    const list = vi.fn(() => new Promise<readonly SkillSummary[]>((resolve) => {
      release = resolve
    }))
    const { url } = await start(list)
    const pending = [fetch(url), fetch(url), fetch(url)]
    await vi.waitFor(() => { expect(list).toHaveBeenCalled() })
    release([summary('a')])
    const bodies = await Promise.all((await Promise.all(pending)).map(res => res.json()))
    expect(list).toHaveBeenCalledTimes(1)
    expect(new Set(bodies.map(body => JSON.stringify(body))).size).toBe(1)
  })

  it('answers 304 to a matching If-None-Match and 200 to a stale one', async () => {
    const { url } = await start(() => Promise.resolve([summary('a')]))
    const first = await fetch(url)
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/u)
    const hit = await fetch(url, { headers: { 'if-none-match': etag } })
    expect(hit.status).toBe(304)
    expect(hit.headers.get('etag')).toBe(etag)
    expect(hit.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate')
    expect(await hit.text()).toBe('')
    expect((await fetch(url, { headers: { 'if-none-match': '"other"' } })).status).toBe(200)
  })

  it('answers 503 on a failed list and succeeds on retry', async () => {
    const list = vi.fn<() => Promise<readonly SkillSummary[]>>()
      .mockRejectedValueOnce(new Error('disk gone: /secret/path'))
      .mockResolvedValue([summary('a')])
    const { url, warn } = await start(list)
    const failed = await fetch(url)
    expect(failed.status).toBe(503)
    const body = await failed.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('skills_unavailable')
    expect(body.error.message).not.toContain('/secret')
    expect(warn).toHaveBeenCalledOnce()
    const retry = await fetch(url)
    expect(retry.status).toBe(200)
    expect(list).toHaveBeenCalledTimes(2)
  })
})

describe('GET /v1/agents/skills targets', () => {
  it('lists with the default preset scope and no cwd when the owner has no workspace root', async () => {
    const list = vi.fn((_options?: SkillViewOptions) => Promise.resolve([summary('a')]))
    const { url, released } = await start(list)
    await fetch(url)
    expect(list).toHaveBeenCalledWith({ scope: DEFAULT_SCOPE, cwd: undefined })
    expect(released).toHaveBeenCalledOnce()
  })

  it('uses the owner default workspace root as cwd when it exists', async () => {
    const list = vi.fn((_options?: SkillViewOptions) => Promise.resolve([summary('a')]))
    const { url, workspacesRoot } = await start(list)
    const root = join(workspacesRoot, 'test')
    await mkdir(root, { recursive: true })
    await fetch(url)
    expect(list.mock.calls[0]?.[0]).toMatchObject({ scope: DEFAULT_SCOPE, cwd: expect.stringContaining('test') })
  })

  it('uses the live agent and workspace of an owned session', async () => {
    const list = vi.fn((_options?: SkillViewOptions) => Promise.resolve([summary('a')]))
    const { url, store } = await start(list)
    await store.sessions.insert(row('sess_live'))
    expect((await fetch(`${url}?session_id=sess_live`)).status).toBe(200)
    expect(list.mock.calls[0]?.[0]?.scope).toBe(LIVE_AGENT)
  })

  it('falls back to the default preset scope for a session that is not live', async () => {
    const list = vi.fn((_options?: SkillViewOptions) => Promise.resolve([summary('a')]))
    const { url, store } = await start(list)
    await store.sessions.insert(row('sess_cold'))
    expect((await fetch(`${url}?session_id=sess_cold`)).status).toBe(200)
    expect(list.mock.calls[0]?.[0]?.scope).toBe(DEFAULT_SCOPE)
  })

  it('answers 404 for another owner session and for an unknown session', async () => {
    const list = vi.fn(() => Promise.resolve([summary('a')]))
    const { url, store } = await start(list)
    await store.sessions.insert(row('sess_theirs', 'other'))
    expect((await fetch(`${url}?session_id=sess_theirs`)).status).toBe(404)
    expect((await fetch(`${url}?session_id=sess_missing`)).status).toBe(404)
    expect(list).not.toHaveBeenCalled()
  })

  it('caches, shares in-flight calls and validates per (scope, cwd)', async () => {
    const list = vi.fn((options?: SkillViewOptions) => Promise.resolve([summary(options?.scope === LIVE_AGENT ? 'live' : 'default')]))
    const { url, store } = await start(list)
    await store.sessions.insert(row('sess_live'))
    const [a, b] = await Promise.all([fetch(url), fetch(`${url}?session_id=sess_live`)])
    expect(list).toHaveBeenCalledTimes(2)
    await fetch(url)
    await fetch(`${url}?session_id=sess_live`)
    expect(list).toHaveBeenCalledTimes(2)
    expect(a.headers.get('etag')).not.toBe(b.headers.get('etag'))
    const stale = await fetch(`${url}?session_id=sess_live`, { headers: { 'if-none-match': a.headers.get('etag')! } })
    expect(stale.status).toBe(200)
    const hit = await fetch(`${url}?session_id=sess_live`, { headers: { 'if-none-match': b.headers.get('etag')! } })
    expect(hit.status).toBe(304)
  })
})

describe('matchesEtag', () => {
  it('compares weakly and accepts lists and *', () => {
    expect(matchesEtag(undefined, '"x"')).toBe(false)
    expect(matchesEtag('"y", W/"x"', '"x"')).toBe(true)
    expect(matchesEtag('*', '"x"')).toBe(true)
    expect(matchesEtag('"y"', '"x"')).toBe(false)
  })
})

describe('skills config', () => {
  const base = { auth: { mode: 'development', devKey: { key: 'k', owner: 'o' } }, database: { url: 'postgres://x' }, workspaces: '/w' }
  it('defaults the TTL to 60 seconds', () => {
    expect(Config(base as never).skills.cacheTtlSeconds).toBe(60)
  })
  it('rejects a negative TTL', () => {
    expect(() => Config({ ...base, skills: { cacheTtlSeconds: -1 } } as never)).toThrow(/cacheTtlSeconds/u)
  })
})
