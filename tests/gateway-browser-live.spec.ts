/** `GET /agents/sessions/{id}/browser/live`: SSE frames from the relay, or `idle` with the reason there is nothing to show. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { browserCdpPort } from '../src/mount-browser.ts'
import type { RelayProcess } from '../src/sandbox/browser-live.ts'
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

class FakeRelay extends PassThrough implements RelayProcess {
  private finish!: (code: number | null) => void
  readonly exited = new Promise<number | null>((r) => { this.finish = r })
  ready = async () => 1
  kill = vi.fn(async () => { this.finish(null) })
}

function row(id: string, environment: SessionConfig['environment'], browser: boolean | null): SessionIndexRow {
  const now = new Date()
  const body = {
    agent: { id, object: 'agent', created_at: 1, updated_at: 1, name: null, instructions: null, model: 'm', tools: [], browser },
    environment, metadata: {}, vault_ids: [],
  } as unknown as SessionConfig
  return { id, ownerId: ownerId('test'), agentId: null, environmentId: null, dshSessionId: id, status: 'idle', lastError: null, model: 'm', reasoningEffort: null, body, createdAt: now, updatedAt: now }
}

async function start() {
  const store = new MemoryStore()
  await store.ensureOwner(ownerId('test'))
  await store.environments.create(ownerId('test'), { id: 'env_sbx', object: 'environment', status: 'connected', provider: 'sandbox', provider_metadata: { sandbox_id: 'sbx_1', workspace_directory: '/workspace' }, created_at: 1 })
  const sandboxEnv = { type: 'sandbox', environment_id: 'env_sbx' } as unknown as SessionConfig['environment']
  await store.sessions.insert(row('sess_on', sandboxEnv, true))
  await store.sessions.insert(row('sess_off', sandboxEnv, false))
  await store.sessions.insert(row('sess_auto', sandboxEnv, null))
  await store.sessions.insert(row('sess_local', { type: 'local' } as unknown as SessionConfig['environment'], true))
  const registry = new SandboxRegistry('local')
  registry.register(createLocalProvider(join(tmpdir(), 'agentry-live-spec-envs')))
  const envd = { fake: 'envd' }
  registry.register({ kind: 'sandbox', listEntries: async () => [], api: () => ({ envd: () => envd }) } as never)
  const relays: FakeRelay[] = []
  const startBrowserRelay = vi.fn(() => { const r = new FakeRelay(); relays.push(r); return r })
  const ctx = { logger: { warn: vi.fn(), info: vi.fn() }, get: () => undefined } as unknown as Context
  const options = { ...testGatewayOptions(registry, new FakeSessionQuery()), browserLiveFps: 10, startBrowserRelay }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, new SessionRegistry(), options)
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/sessions`, relays, startBrowserRelay, envd }
}

/** Reads SSE events until `count` arrive, then aborts the request. */
async function events(url: string, count: number, onOpen?: () => void): Promise<{ event: string; data: unknown }[]> {
  const abort = new AbortController()
  const res = await fetch(url, { signal: abort.signal })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  onOpen?.()
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

describe('browser live route', () => {
  it('streams the relay\'s frames for a sandbox chat with the browser on', async () => {
    const { base, relays, startBrowserRelay, envd } = await start()
    const got = await events(`${base}/sess_on/browser/live`, 2, () => {
      void vi.waitFor(() => { expect(relays).toHaveLength(1) }).then(() => {
        relays[0]!.write('{"type":"idle","reason":"not_started"}\n')
        relays[0]!.write('{"type":"frame","data":"/9j/AA==","url":"https://example.com/","title":"Example","width":1280,"height":720,"ts":5}\n')
      })
    })
    expect(got).toEqual([
      { event: 'idle', data: { reason: 'not_started' } },
      { event: 'frame', data: { data: '/9j/AA==', url: 'https://example.com/', title: 'Example', width: 1280, height: 720, timestamp: 5 } },
    ])
    expect(startBrowserRelay).toHaveBeenCalledWith(envd, browserCdpPort('sess_on'), 100)
  })

  it('says the sandbox image has no browser', async () => {
    const { base, relays } = await start()
    const got = await events(`${base}/sess_on/browser/live`, 1, () => {
      void vi.waitFor(() => { expect(relays).toHaveLength(1) }).then(() => { relays[0]!.write('{"type":"idle","reason":"no_browser"}\n') })
    })
    expect(got).toEqual([{ event: 'idle', data: { reason: 'no_browser' } }])
  })

  it('says why without a relay: a local chat, or an agent with the browser off', async () => {
    const { base, startBrowserRelay } = await start()
    expect(await events(`${base}/sess_local/browser/live`, 1)).toEqual([{ event: 'idle', data: { reason: 'not_sandbox' } }])
    expect(await events(`${base}/sess_off/browser/live`, 1)).toEqual([{ event: 'idle', data: { reason: 'browser_off' } }])
    expect(startBrowserRelay).not.toHaveBeenCalled()
  })

  it('keeps the live view for auto agents (the relay reports no_browser) and says browser_off for off', async () => {
    const { base, relays } = await start()
    const got = await events(`${base}/sess_auto/browser/live`, 1, () => {
      void vi.waitFor(() => { expect(relays).toHaveLength(1) }).then(() => { relays[0]!.write('{"type":"idle","reason":"no_browser"}\n') })
    })
    expect(got).toEqual([{ event: 'idle', data: { reason: 'no_browser' } }])
  })

  it('hides unknown sessions', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/sess_nope/browser/live`)).status).toBe(404)
  })
})
