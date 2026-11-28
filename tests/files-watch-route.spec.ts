import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SandboxRegistry } from '../src/sandbox/registry.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import type { SessionIndexRow } from '../src/store/store.ts'
import type { SessionConfig } from '../src/types.ts'
import { openAuthenticator } from './open-auth.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

function row(id: string, owner: string, environment: SessionConfig['environment']): SessionIndexRow {
  const now = new Date()
  const body = {
    agent: { id, object: 'agent', created_at: 1, updated_at: 1, name: null, instructions: null, model: 'm', tools: [] },
    environment, metadata: {}, vault_ids: [],
  } as unknown as SessionConfig
  return { id, ownerId: ownerId(owner), agentId: null, environmentId: null, projectId: null, dshSessionId: id, status: 'idle', lastError: null, model: 'm', reasoningEffort: null, body, createdAt: now, updatedAt: now }
}

type WatchBatch = string[] | 'end'
function watchSource(batches: WatchBatch[]) {
  return (_record: unknown, signal: AbortSignal): AsyncIterable<string[]> => ({
    async *[Symbol.asyncIterator]() {
      for (const batch of batches) {
        if (signal.aborted) return
        if (batch === 'end') return
        yield batch
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
  })
}

async function start(batches: WatchBatch[] = [['a.txt'], 'end']) {
  const store = new MemoryStore()
  await store.ensureOwner(ownerId('test'))
  await store.ensureOwner(ownerId('other'))
  await store.environments.create(ownerId('test'), { id: 'env_sbx', object: 'environment', status: 'connected', provider: 'sandbox', provider_metadata: { sandbox_id: 'sbx_1', workspace_directory: '/workspace' }, created_at: 1 })
  const sandboxEnv = { type: 'sandbox', environment_id: 'env_sbx' } as unknown as SessionConfig['environment']
  await store.sessions.insert(row('sess_sbx', 'test', sandboxEnv))
  await store.sessions.insert(row('sess_theirs', 'other', sandboxEnv))

  const registry = new SandboxRegistry('local')
  registry.register(createLocalProvider(join(tmpdir(), 'agentry-watch-envs')))
  registry.register({
    kind: 'sandbox',
    listEntries: async () => [],
    watch: watchSource(batches),
    api: () => ({ envd: () => ({}) }),
  } as never)

  const ctx = { logger: { warn: vi.fn(), info: vi.fn() }, get: () => undefined } as unknown as Context
  const options = { ...testGatewayOptions(registry, new FakeSessionQuery()) }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, new SessionRegistry(), options)
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`
  return { base }
}

async function readEvents(url: string, count: number): Promise<{ event: string; data: unknown }[]> {
  const abort = new AbortController()
  const res = await fetch(url, { signal: abort.signal })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const out: { event: string; data: unknown }[] = []
  let text = ''
  while (out.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
    let at: number
    while ((at = text.indexOf('\n\n')) >= 0) {
      const block = text.slice(0, at)
      text = text.slice(at + 2)
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (event && data) out.push({ event, data: JSON.parse(data) })
    }
  }
  abort.abort()
  return out
}

describe('artifacts watch route', () => {
  it('streams changed and closed events for the session owner', async () => {
    const { base } = await start([['a.txt', 'b.txt'], 'end'])
    const got = await readEvents(`${base}/agents/sessions/sess_sbx/artifacts/watch`, 2)
    expect(got).toEqual([
      { event: 'changed', data: { paths: ['a.txt', 'b.txt'] } },
      { event: 'closed', data: {} },
    ])
  })

  it('streams reset when the source batch is large', async () => {
    const paths = Array.from({ length: 201 }, (_, i) => `f${String(i)}.txt`)
    const { base } = await start([paths, 'end'])
    const got = await readEvents(`${base}/agents/sessions/sess_sbx/artifacts/watch`, 2)
    expect(got[0]).toEqual({ event: 'reset', data: {} })
    expect(got[1]).toEqual({ event: 'closed', data: {} })
  })

  it('hides another owner session', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/agents/sessions/sess_theirs/artifacts/watch`)
    expect(res.status).toBe(404)
  })
})
