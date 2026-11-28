import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId, type Authenticator } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'

const byHeader: Authenticator = {
  authenticate: req => Promise.resolve({ ok: true as const, principal: { owner: ownerId(String(req.headers['x-owner'] ?? 'alice')), roles: new Set(['agentry-user' as const]) } }),
}

const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

async function start() {
  const github = vi.fn(async (url: string) => {
    if (url.includes('/contents/')) return Response.json([{ type: 'file', name: 'planner.md', path: 'agents/planner.md' }, { type: 'file', name: 'README.md', path: 'agents/README.md' }])
    if (url.endsWith('/README.md')) return new Response('# Agents')
    return new Response('---\nname: planner\ndescription: Plans work\n---\nPlan it.')
  })
  const ctx = { logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, tools: { schemas: () => [] } } as unknown as Context
  const api = new AgentsGateway(ctx, byHeader, '/v1', new MemoryStore(), new SessionRegistry(), {
    ...testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-library')), new FakeSessionQuery()),
    skillsGithub: { apiBase: 'https://api.github.test', codeloadBase: '', fetch: async url => github(String(url)) },
  })
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/library/sources`
  const call = async (path: string, init: { method?: string; body?: unknown; owner?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'x-owner': init.owner ?? 'alice', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  return { call, github }
}

describe('/agents/library/sources', () => {
  it('adds, lists (cached) and removes sources per owner', async () => {
    const { call, github } = await start()
    const added = await call('', { method: 'POST', body: { label: 'ECC', url: 'https://github.com/o/r/tree/main/agents' } })
    expect(added.status).toBe(200)
    expect(added.body).toMatchObject({ object: 'library.source', label: 'ECC', url: 'https://github.com/o/r/tree/main/agents' })
    const id = added.body['id'] as string

    const agents = await call(`/${id}/agents`)
    expect(agents.body).toEqual({ object: 'list', source_id: id, data: [{ name: 'planner', description: 'Plans work', url: 'https://github.com/o/r/blob/main/agents/planner.md' }] })
    const reads = github.mock.calls.length
    await call(`/${id}/agents`)
    expect(github.mock.calls.length).toBe(reads)
    await call(`/${id}/agents?refresh=1`)
    expect(github.mock.calls.length).toBeGreaterThan(reads)

    // Another owner sees nothing and cannot read or remove alice's source.
    expect((await call('', { owner: 'bob' })).body['data']).toEqual([])
    expect((await call(`/${id}/agents`, { owner: 'bob' })).status).toBe(404)
    expect((await call(`/${id}`, { method: 'DELETE', owner: 'bob' })).status).toBe(404)

    expect((await call('', { method: 'POST', body: { label: 'ecc', url: 'https://github.com/o/r/tree/main/agents' } })).body['error'].code).toBe('library_source_exists')
    expect((await call(`/${id}`, { method: 'DELETE' })).body).toEqual({ id, object: 'library.source.deleted', deleted: true })
    expect((await call('')).body['data']).toEqual([])
  })

  it('refuses other hosts, single files, the reserved label and an eleventh source', async () => {
    const { call } = await start()
    const code = async (body: unknown) => { const r = await call('', { method: 'POST', body }); return [r.status, r.body['error']?.code] }
    expect(await code({ label: 'X', url: 'https://example.com/agents' })).toEqual([400, 'import_host_not_allowed'])
    expect(await code({ label: 'X', url: 'http://github.com/o/r/tree/main/agents' })).toEqual([400, 'import_host_not_allowed'])
    expect(await code({ label: 'X', url: 'https://github.com/o/r/blob/main/agents/planner.md' })).toEqual([400, 'import_unrecognized'])
    expect(await code({ label: 'Agentry', url: 'https://github.com/o/r/tree/main/agents' })).toEqual([400, 'invalid_label'])
    for (let i = 0; i < 10; i++) expect((await call('', { method: 'POST', body: { label: `S${String(i)}`, url: 'https://github.com/o/r/tree/main/agents' } })).status).toBe(200)
    expect(await code({ label: 'S10', url: 'https://github.com/o/r/tree/main/agents' })).toEqual([409, 'library_sources_limit'])
  })
})
