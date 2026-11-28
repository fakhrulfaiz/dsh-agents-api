import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { openAuthenticator } from './open-auth.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'

const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

async function start(github: (url: string) => Response) {
  const store = new MemoryStore()
  const ctx = { logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, tools: { schemas: () => [{ name: 'read' }, { name: 'grep' }] } } as unknown as Context
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, new SessionRegistry(), {
    ...testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-import-routes')), new FakeSessionQuery()),
    skillsGithub: { apiBase: 'https://api.github.test', codeloadBase: '', fetch: async url => github(String(url)) },
  })
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const post = (body: unknown) => fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { post, store }
}

describe('POST /agents/import', () => {
  it('answers drafts for text and file links, candidates for folders, and saves nothing', async () => {
    const { post, store } = await start((url) => {
      if (url.includes('/contents/')) return Response.json([{ type: 'file', name: 'a.md', path: 'agents/a.md' }])
      return new Response('---\nname: code-reviewer\ndescription: Reviews\ntools: Read, Bash\n---\nReview it.')
    })
    const text = await (await post({ text: '---\nname: helper\ndescription: d\n---\nHelp.' })).json()
    expect(text).toEqual({ object: 'agent.import.draft', draft: { name: 'Helper', instructions: 'Help.', metadata: { description: 'd' } }, source: { format: 'ecc' }, notes: [] })
    const link = await (await post({ url: 'https://github.com/o/r/blob/main/agents/a.md' })).json()
    expect(link).toMatchObject({
      object: 'agent.import.draft',
      draft: { name: 'Code reviewer', host_tools: { allow: ['read'] }, metadata: { source_url: 'https://github.com/o/r/blob/main/agents/a.md' } },
      source: { url: 'https://github.com/o/r/blob/main/agents/a.md', format: 'ecc' },
      notes: ['Dropped tools this server does not have: Bash.'],
    })
    expect(await (await post({ url: 'https://github.com/o/r/tree/main/agents' })).json()).toMatchObject({ object: 'agent.import.candidates', data: [{ name: 'code-reviewer' }] })
    await store.ensureOwner(ownerId('test'))
    expect((await store.agents.list(ownerId('test'), { limit: 10, order: 'desc' } as never)).data).toEqual([])
  })

  it('maps refusals to their codes', async () => {
    const { post } = await start(() => new Response('', { status: 500 }))
    const res = async (body: unknown) => { const r = await post(body); return [r.status, ((await r.json()) as { error: { code: string } }).error.code] }
    expect(await res({})).toEqual([400, 'bad_request'])
    expect(await res({ url: 'https://github.com/o/r/blob/m/a.md', text: 'x' })).toEqual([400, 'bad_request'])
    expect(await res({ text: 'not an agent' })).toEqual([400, 'import_unrecognized'])
    expect(await res({ url: 'https://example.com/a.md' })).toEqual([400, 'import_host_not_allowed'])
    expect(await res({ url: 'https://github.com/o/r/blob/m/a.md' })).toEqual([502, 'import_fetch_failed'])
  })
})
