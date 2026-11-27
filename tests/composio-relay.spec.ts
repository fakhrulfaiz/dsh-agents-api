import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposioRelay, RELAY_PATH_PREFIX, parseUpstream, relayEnabled } from '../src/composio-relay.ts'
import type { OAIMcpTool } from '../src/types.ts'

interface Upstream { url: string; calls: string[]; delayMs: number; sessions: number; expireNext: boolean; close(): Promise<void> }

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()) })))
})

async function listen(handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function upstream(): Promise<Upstream> {
  const state = { calls: [] as string[], delayMs: 0, sessions: 0, expireNext: false }
  const url = await listen((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown; method: string; params?: unknown }
      state.calls.push(message.method)
      const sid = req.headers['mcp-session-id']
      const send = (body: unknown, sse = false) => {
        if (sse) {
          res.setHeader('Content-Type', 'text/event-stream')
          res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
        } else {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
      }
      if (message.method === 'initialize') {
        state.sessions += 1
        res.setHeader('mcp-session-id', `up-${state.sessions}`)
        return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } })
      }
      if (message.id === undefined) { res.statusCode = 202; return res.end() }
      if (state.expireNext || sid === undefined) { state.expireNext = false; res.statusCode = 404; return res.end() }
      setTimeout(() => {
        if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'T', inputSchema: {} }] } }, true)
        if (message.method === 'tools/call') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `ok:${String(sid)}` }] } })
        send({ jsonrpc: '2.0', id: message.id, result: {} })
      }, state.delayMs)
    })
  })
  return Object.assign(state, { url, close: async () => undefined })
}

const composioTool = (url: string): OAIMcpTool => ({
  type: 'mcp', server_label: 'composio', required: false,
  transport: { type: 'http', server_url: url, headers: { 'x-consumer-api-key': 'secret' } },
})

async function harness(opts: { cacheDir?: string; origin?: boolean } = {}) {
  const up = await upstream()
  let relay!: ComposioRelay
  const relayOrigin = await listen((req, res) => { void relay.handle(req, res) })
  relay = new ComposioRelay({
    serverLabel: 'composio',
    origin: () => opts.origin === false ? undefined : relayOrigin,
    ...(opts.cacheDir === undefined ? {} : { cacheDir: opts.cacheDir }),
  })
  // The relay only rewrites the real Composio host, so a test points the fake upstream through a fetch shim.
  const real = globalThis.fetch
  const shimmed = new ComposioRelay({
    serverLabel: 'composio',
    origin: () => opts.origin === false ? undefined : relayOrigin,
    ...(opts.cacheDir === undefined ? {} : { cacheDir: opts.cacheDir }),
    fetch: ((input: string, init?: RequestInit) => real(String(input).replace('https://connect.composio.dev/mcp', up.url), init)) as typeof fetch,
  })
  relay = shimmed
  const tool = composioTool('https://connect.composio.dev/mcp')
  return { up, relay: shimmed, relayOrigin, tool }
}

async function rpc(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, json: text === '' ? undefined : JSON.parse(text) }
}

describe('ComposioRelay rewrite', () => {
  it('rewrites only the Composio label on the Composio host, hiding the key', async () => {
    const { relay, relayOrigin, tool } = await harness()
    const out = relay.rewrite(tool)
    expect(out.transport).toMatchObject({ type: 'http', headers: {} })
    const url = (out.transport as { server_url: string }).server_url
    expect(url.startsWith(`${relayOrigin}${RELAY_PATH_PREFIX}`)).toBe(true)
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(out.server_label).toBe('composio')
    expect(out.required).toBe(false)
    // Same key, same token; other label, other host, stdio and a missing origin stay untouched.
    expect((relay.rewrite(tool).transport as { server_url: string }).server_url).toBe(url)
    const other = { ...tool, server_label: 'docs' }
    expect(relay.rewrite(other)).toBe(other)
    const elsewhere = composioTool('https://example.com/mcp')
    expect(relay.rewrite(elsewhere)).toBe(elsewhere)
    const stdio: OAIMcpTool = { type: 'mcp', server_label: 'composio', transport: { type: 'stdio', command: 'x' } }
    expect(relay.rewrite(stdio)).toBe(stdio)
    const off = await harness({ origin: false })
    expect(off.relay.rewrite(off.tool)).toBe(off.tool)
    const other2 = composioTool('https://connect.composio.dev/mcp')
    other2.transport = { type: 'http', server_url: 'https://connect.composio.dev/mcp', headers: { 'x-consumer-api-key': 'different' } }
    expect((relay.rewrite(other2).transport as { server_url: string }).server_url).not.toBe(url)
  })

  it('has an off switch', () => {
    expect(relayEnabled({})).toBe(true)
    expect(relayEnabled({ AGENTRY_COMPOSIO_RELAY: 'off' })).toBe(false)
    expect(relayEnabled({ AGENTRY_COMPOSIO_RELAY: 'on' })).toBe(true)
  })
})

describe('ComposioRelay serving', () => {
  it('answers initialize locally without touching the upstream', async () => {
    const { up, relay, tool } = await harness()
    up.delayMs = 0
    const url = (relay.rewrite(tool).transport as { server_url: string }).server_url
    await vi_waitFor(() => up.calls.includes('tools/list'))
    await new Promise(r => setTimeout(r, 50))
    const before = up.calls.length
    const init = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(init.json.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    const note = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    expect(note.status).toBe(202)
    expect(up.calls.length).toBe(before)
  })

  it('serves tools/list from the warm cache while the upstream is slow, and shares one upstream session', async () => {
    const { up, relay, tool } = await harness()
    const url = (relay.rewrite(tool).transport as { server_url: string }).server_url
    await vi_waitFor(() => up.calls.includes('tools/list'))
    await new Promise(r => setTimeout(r, 30))
    up.delayMs = 1500
    const second = relay.rewrite(tool) // a second session of the same owner
    const url2 = (second.transport as { server_url: string }).server_url
    const started = Date.now()
    const list = await rpc(url2, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(Date.now() - started).toBeLessThan(500)
    expect(list.json.result.tools[0].name).toBe('T')
    expect(up.sessions).toBe(1)
    expect(up.calls.filter(c => c === 'initialize')).toHaveLength(1)
    const call = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'T' } })
    expect(call.json.result.content[0].text).toBe('ok:up-1')
    expect(up.sessions).toBe(1)
  })

  it('re-initializes once when the upstream session expired', async () => {
    const { up, relay, tool } = await harness()
    const url = (relay.rewrite(tool).transport as { server_url: string }).server_url
    await vi_waitFor(() => up.calls.includes('tools/list'))
    up.expireNext = true
    const call = await rpc(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'T' } })
    expect(call.json.result.content[0].text).toBe('ok:up-2')
    expect(up.sessions).toBe(2)
  })

  it('returns an isError result when the upstream is down', async () => {
    const { relay, relayOrigin } = await harness()
    const dead = new ComposioRelay({ serverLabel: 'composio', origin: () => relayOrigin, fetch: (async () => { throw new Error('connect refused') }) as typeof fetch })
    let handler = dead
    const origin = await listen((req, res) => { void handler.handle(req, res) })
    handler = new ComposioRelay({ serverLabel: 'composio', origin: () => origin, fetch: (async () => { throw new Error('connect refused') }) as typeof fetch })
    const url = (handler.rewrite(composioTool('https://connect.composio.dev/mcp')).transport as { server_url: string }).server_url
    const call = await rpc(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'T' } })
    expect(call.json.result.isError).toBe(true)
    expect(call.json.result.content[0].text).toContain('connect refused')
    const list = await rpc(url, { jsonrpc: '2.0', id: 6, method: 'tools/list' })
    expect(list.json.error.message).toContain('connect refused')
    void relay
  })

  it('answers 404 for an unknown token and 405 for GET', async () => {
    const { relay, relayOrigin, tool } = await harness()
    const missing = await rpc(`${relayOrigin}${RELAY_PATH_PREFIX}nope`, { jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(missing.status).toBe(404)
    const url = (relay.rewrite(tool).transport as { server_url: string }).server_url
    expect((await fetch(url)).status).toBe(405)
  })

  it('refuses a peer that is not local', async () => {
    const { relay, tool } = await harness()
    const url = (relay.rewrite(tool).transport as { server_url: string }).server_url
    const token = url.slice(url.lastIndexOf('/') + 1)
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v }, end(b?: string) { this.body = b ?? '' } }
    const req = { url: `${RELAY_PATH_PREFIX}${token}`, method: 'POST', socket: { remoteAddress: '203.0.113.9', localAddress: '10.0.0.5' } }
    await relay.handle(req as never, res as never)
    expect(res.statusCode).toBe(403)
  })

  it('persists the tool list so a restart serves it with the upstream down', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'relay-cache-'))
    const first = await harness({ cacheDir })
    first.relay.rewrite(first.tool)
    await vi_waitFor(async () => (await readdir(cacheDir)).some(f => f.endsWith('.json')))
    expect(JSON.stringify(await readdir(cacheDir))).not.toContain('secret')
    // A new process: same cache folder, upstream refusing every call.
    const up = await upstream()
    let relay!: ComposioRelay
    const origin = await listen((req, res) => { void relay.handle(req, res) })
    relay = new ComposioRelay({ serverLabel: 'composio', origin: () => origin, cacheDir, fetch: (async () => { throw new Error('down') }) as typeof fetch })
    const url = (relay.rewrite(first.tool).transport as { server_url: string }).server_url
    const list = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.json.result.tools[0].name).toBe('T')
    void up
  })
})

describe('parseUpstream', () => {
  it('reads JSON and SSE replies', () => {
    expect(parseUpstream('{"id":1,"result":{}}', 1)).toEqual({ id: 1, result: {} })
    expect(parseUpstream('event: message\ndata: {"id":2,"result":1}\n\n', 2)).toEqual({ id: 2, result: 1 })
    expect(parseUpstream('', 1)).toBeNull()
  })
})

async function vi_waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('timed out waiting')
}
