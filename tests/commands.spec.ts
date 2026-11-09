/**
 * `GET /v1/agents/commands`: mapping, targets, caching, validators, and failures.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { ownerId } from '../src/auth/authenticator.ts'
import type { SessionIndexRow } from '../src/store/store.ts'
import { openAuthenticator } from './open-auth.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'
import { Config } from '../src/index.ts'

const servers: Server[] = []
const environments = createLocalProvider(join(tmpdir(), 'agentry-commands-spec'))

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

/** A descriptor with the fields the route reads. */
function descriptor(name: string, extra: Partial<CommandDescriptor> = {}): CommandDescriptor {
  return { name, description: `${name} command`, ...extra }
}

const DEFAULT_SCOPE = { name: 'default-preset-scope' }
const LIVE_AGENT = { name: 'live-agent' }

/** Session index row owned by `owner`. */
function row(id: string, owner = 'test'): SessionIndexRow {
  const now = new Date()
  return { id, ownerId: ownerId(owner), agentId: null, environmentId: null, dshSessionId: id, status: 'idle', lastError: null, model: 'm', reasoningEffort: null, body: null, createdAt: now, updatedAt: now }
}

type List = (agent: unknown) => readonly CommandDescriptor[]

/** A gateway over a command service stub; `list` is the stub's single method. */
async function start(list: List | undefined, ttlMs = 60_000) {
  const warn = vi.fn()
  const released = vi.fn()
  const store = new MemoryStore()
  await store.ensureOwner(ownerId('test'))
  await store.ensureOwner(ownerId('other'))
  const ctx = {
    logger: { warn },
    get: (name: string) => name === 'agentPresets'
      ? { acquireScope: () => Promise.resolve({ key: DEFAULT_SCOPE, [Symbol.asyncDispose]: () => { released(); return Promise.resolve() } }) }
      : undefined,
    agents: { get: (id: string) => id === 'sess_live' ? LIVE_AGENT : undefined },
  } as unknown as Context
  const base = testGatewayOptions(environments, new FakeSessionQuery())
  const options = { ...base, commands: () => list === undefined ? undefined : { list }, commandsTtlMs: ttlMs }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, new SessionRegistry(), options)
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/commands`
  await store.sessions.insert(row('sess_live'))
  await store.sessions.insert(row('sess_cold'))
  return { url: `${url}?session_id=sess_live`, bare: url, base: url, warn, store, released, api }
}

describe('GET /v1/agents/commands', () => {
  it('maps descriptors, hides definitionId, and sorts by name', async () => {
    const { url } = await start(() => [
      descriptor('goal', { input: { hint: '<objective>', attachments: false }, definitionId: 'internal' as never }),
      descriptor('compact'),
      descriptor('feedback', { input: { hint: 'text', attachments: true } }),
    ])
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate')
    expect(await res.json()).toEqual({
      object: 'list',
      data: [
        { name: 'compact', description: 'compact command', accepts_attachments: false },
        { name: 'feedback', description: 'feedback command', input_hint: 'text', accepts_attachments: true },
        { name: 'goal', description: 'goal command', input_hint: '<objective>', accepts_attachments: false },
      ],
    })
  })

  it('answers an empty list without a session_id', async () => {
    const list = vi.fn(() => [descriptor('compact')])
    const { bare } = await start(list)
    const res = await fetch(bare)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ object: 'list', data: [] })
    expect(list).not.toHaveBeenCalled()
  })

  it('answers an empty list without the command service', async () => {
    const { url } = await start(undefined)
    expect(await (await fetch(url)).json()).toEqual({ object: 'list', data: [] })
  })

  it('lists with the live agent of an owned session', async () => {
    const list = vi.fn((_agent: unknown) => [descriptor('compact')])
    const { url } = await start(list)
    await fetch(url)
    expect(list).toHaveBeenCalledWith(LIVE_AGENT)
  })

  it('serves a session that is not live from the default preset scope', async () => {
    const list = vi.fn((_agent: unknown) => [descriptor('compact')])
    const { base, released } = await start(list)
    expect((await fetch(`${base}?session_id=sess_cold`)).status).toBe(200)
    expect(list).toHaveBeenCalledWith(DEFAULT_SCOPE)
    expect(released).toHaveBeenCalledOnce()
  })

  it('answers 404 for another owner session and for an unknown session', async () => {
    const list = vi.fn(() => [descriptor('compact')])
    const { base, store } = await start(list)
    await store.sessions.insert(row('sess_theirs', 'other'))
    expect((await fetch(`${base}?session_id=sess_theirs`)).status).toBe(404)
    expect((await fetch(`${base}?session_id=sess_missing`)).status).toBe(404)
    expect(list).not.toHaveBeenCalled()
  })

  it('serves a cache hit within the TTL from one list call', async () => {
    const list = vi.fn(() => [descriptor('a')])
    const { url } = await start(list)
    await fetch(url)
    await fetch(url)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('caches per scope', async () => {
    const list = vi.fn((agent: unknown) => [descriptor(agent === LIVE_AGENT ? 'live' : 'cold')])
    const { url, base } = await start(list)
    const live = await fetch(url)
    const cold = await fetch(`${base}?session_id=sess_cold`)
    await fetch(url)
    await fetch(`${base}?session_id=sess_cold`)
    expect(list).toHaveBeenCalledTimes(2)
    expect(live.headers.get('etag')).not.toBe(cold.headers.get('etag'))
  })

  it('calls list again once the TTL passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const list = vi.fn(() => [descriptor('a')])
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
    const list = vi.fn(() => [descriptor('a')])
    const { url } = await start(list, 0)
    await fetch(url)
    await fetch(url)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('reads again after the registry changes', async () => {
    const list = vi.fn(() => [descriptor('a')])
    const { url, api } = await start(list)
    await fetch(url)
    api.invalidateCommands()
    await fetch(url)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('reads again after a session event selects a preset', async () => {
    const list = vi.fn(() => [descriptor('a')])
    const { url, api } = await start(list)
    await fetch(url)
    api.applySessionEvent('sess_live', { type: 'agent-preset/selected', data: { agentPreset: 'minimal' }, seq: 1, time: 0 } as never)
    await fetch(url)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('answers 304 to a matching If-None-Match and 200 to a stale one', async () => {
    const { url } = await start(() => [descriptor('a')])
    const etag = (await fetch(url)).headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/u)
    const hit = await fetch(url, { headers: { 'if-none-match': etag } })
    expect(hit.status).toBe(304)
    expect(await hit.text()).toBe('')
    expect((await fetch(url, { headers: { 'if-none-match': '"other"' } })).status).toBe(200)
  })

  it('answers 503 on a failed list and succeeds on retry', async () => {
    const list = vi.fn<List>()
      .mockImplementationOnce(() => { throw new Error('boom: /secret/path') })
      .mockReturnValue([descriptor('a')])
    const { url, warn } = await start(list)
    const failed = await fetch(url)
    expect(failed.status).toBe(503)
    const body = await failed.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('commands_unavailable')
    expect(body.error.message).not.toContain('/secret')
    expect(warn).toHaveBeenCalledOnce()
    expect((await fetch(url)).status).toBe(200)
  })
})

describe('commands config', () => {
  const base = { auth: { mode: 'development', devKey: { key: 'k', owner: 'o' } }, database: { url: 'postgres://x' }, workspaces: '/w' }
  it('defaults the TTL to 60 seconds', () => {
    expect(Config(base as never).commands.cacheTtlSeconds).toBe(60)
  })
  it('rejects a negative TTL', () => {
    expect(() => Config({ ...base, commands: { cacheTtlSeconds: -1 } } as never)).toThrow(/commands.cacheTtlSeconds/u)
  })
})
