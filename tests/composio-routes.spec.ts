/**
 * `/agents/connectors/composio…`: the owner's sealed Composio key and connection lookups.
 * The key never appears in a response or a log line.
 */
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

const KEY = 'ck_secret_value_1234'
const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

const byHeader: Authenticator = {
  authenticate: req => Promise.resolve({ ok: true as const, principal: { owner: ownerId(String(req.headers['x-owner'] ?? 'owner-a')), roles: new Set(['agentry-user' as const]) } }),
}

function rpcText(results: Record<string, unknown>): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ successful: true, data: { results } }) }] } })}\n\n`
}

async function start(options: { secretsKey?: string | undefined; composio?: typeof fetch } = {}) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const store = new MemoryStore()
  const api = new AgentsGateway({ logger } as unknown as Context, byHeader, '/v1', store, new SessionRegistry(), {
    ...testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-composio-routes')), new FakeSessionQuery()),
    ...('secretsKey' in options ? { secretsKey: options.secretsKey } : { secretsKey: 'k'.repeat(48) }),
    ...(options.composio === undefined ? {} : { composioFetch: options.composio }),
  })
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/connectors/composio`
  const call = (path: string, init: RequestInit & { owner?: string } = {}) => fetch(`${base}${path}`, { ...init, headers: { 'x-owner': init.owner ?? 'owner-a', ...(init.body ? { 'content-type': 'application/json' } : {}) } })
  return { call, logger, store }
}

describe('Composio key routes', () => {
  it('saves, reports last4 only, scopes to the owner and removes', async () => {
    const { call, logger, store } = await start()
    expect(await (await call('')).json()).toEqual({ object: 'connector.key', configured: false, last4: null, updated_at: null })
    const saved = await call('', { method: 'POST', body: JSON.stringify({ key: KEY }) })
    const text = await saved.text()
    expect(saved.status).toBe(200)
    expect(text).not.toContain(KEY)
    expect(JSON.parse(text)).toMatchObject({ configured: true, last4: '1234', updated_at: expect.any(Number) })
    expect(await (await call('')).text()).not.toContain(KEY)
    expect(await (await call('', { owner: 'owner-b' })).json()).toMatchObject({ configured: false })
    await call('', { method: 'DELETE', owner: 'owner-b' })
    expect(await (await call('')).json()).toMatchObject({ configured: true })
    expect(JSON.stringify(await store.secrets.get(ownerId('owner-a'), 'composio'))).not.toContain(KEY)
    expect(await (await call('', { method: 'DELETE' })).json()).toMatchObject({ configured: false })
    expect(await (await call('')).json()).toMatchObject({ configured: false })
    expect(JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.error.mock.calls])).not.toContain(KEY)
  })

  it('refuses keys that do not start with ck_', async () => {
    const { call } = await start()
    const res = await call('', { method: 'POST', body: JSON.stringify({ key: 'nope' }) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_key' } })
  })

  it('answers 501 secrets_disabled without secrets.key', async () => {
    const { call } = await start({ secretsKey: undefined })
    for (const init of [{}, { method: 'POST', body: JSON.stringify({ key: KEY }) }, { method: 'DELETE' }]) {
      const res = await call('', init)
      expect(res.status).toBe(501)
      expect(await res.json()).toMatchObject({ error: { code: 'secrets_disabled' } })
    }
  })
})

describe('Composio connections route', () => {
  it('lists accounts per toolkit with the stored key', async () => {
    const composio = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string }
      expect(new Headers(init?.headers).get('x-consumer-api-key')).toBe(KEY)
      if (body.method === 'initialize') return new Response('{}', { headers: { 'mcp-session-id': 's1' } })
      return new Response(rpcText({ gmail: { accounts: [{ id: 'ca_1', alias: 'work', status: 'active' }] }, github: { accounts: [] } }))
    })
    const { call } = await start({ composio })
    await call('', { method: 'POST', body: JSON.stringify({ key: KEY }) })
    const res = await call('/connections?toolkits=gmail,github')
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain(KEY)
    expect(JSON.parse(text)).toEqual({
      object: 'connector.connections',
      data: { gmail: { connected: true, accounts: [{ id: 'ca_1', alias: 'work', status: 'active' }] }, github: { connected: false, accounts: [] } },
    })
  })

  it('answers 409 without a key, 502 rejected on a refused key, 400 on bad toolkits', async () => {
    const composio = vi.fn<typeof fetch>(async () => new Response('no', { status: 401 }))
    const { call } = await start({ composio })
    expect((await (await call('/connections?toolkits=gmail')).json())).toMatchObject({ error: { code: 'connector_key_missing' } })
    await call('', { method: 'POST', body: JSON.stringify({ key: KEY }) })
    const refused = await call('/connections?toolkits=gmail')
    expect(refused.status).toBe(502)
    expect(await refused.json()).toMatchObject({ error: { code: 'connector_unavailable', reason: 'rejected' } })
    expect((await call('/connections?toolkits=../x')).status).toBe(400)
    expect((await call('/connections')).status).toBe(400)
  })
})
