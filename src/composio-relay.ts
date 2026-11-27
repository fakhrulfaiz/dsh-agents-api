/**
 * Local MCP relay in front of the owner's Composio connector.
 *
 * DSH's mcp-client blocks agent setup on the first connection plus `tools/list`; to Composio that is about two
 * seconds before a new chat's first turn can start. The API instead points the agent's Composio tool at this relay
 * (`/internal/mcp-relay/<token>` on its own web server). The relay answers `initialize` at once, serves `tools/list`
 * from a cache (memory, plus a JSON file so a restart keeps it warm) and forwards calls over one shared upstream
 * session per connector key. The key never appears in the URL: the token only maps to it in memory.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OAIMcpTool } from './types.ts'

/** URL path prefix the relay is served under. */
export const RELAY_PATH_PREFIX = '/internal/mcp-relay/'

const COMPOSIO_HOST = 'connect.composio.dev'
const MAX_BODY_BYTES = 20 * 1024 * 1024
const CALL_TIMEOUT_MS = 10 * 60_000
const LIST_TIMEOUT_MS = 30_000
const REFRESH_AFTER_MS = 30_000

type Json = Record<string, unknown>

interface CachedPage {
  result: unknown
  at: number
}

interface Entry {
  token: string
  keyHash: string
  url: string
  headers: Record<string, string>
  /** Shared upstream MCP session id; empty when the server is stateless. */
  sessionId: string
  initializing: Promise<void> | undefined
  pages: Map<string, CachedPage>
  loaded: Promise<void> | undefined
  refreshing: Map<string, Promise<CachedPage>>
}

/** Options for {@link ComposioRelay}. */
export interface ComposioRelayOptions {
  /** Label of the Composio MCP tool; only that tool is rewritten (default `composio`). */
  serverLabel: string
  /** Origin the agent's MCP client reaches this API at, for example `http://127.0.0.1:3080`; `undefined` disables the rewrite. */
  origin: () => string | undefined
  /** Folder for the persisted tool lists; `undefined` keeps them in memory only. */
  cacheDir?: string
  /** Replaceable for tests. */
  fetch?: typeof fetch
  /** Receives non-fatal problems (warm-up and cache-write failures). */
  warn?: (message: string) => void
}

/** Whether `AGENTRY_COMPOSIO_RELAY` leaves the relay on (anything but `off`, `0` or `false`). */
export function relayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env['AGENTRY_COMPOSIO_RELAY']?.trim().toLowerCase()
  return value !== 'off' && value !== '0' && value !== 'false'
}

/** The relay: rewrites Composio MCP tools to point at itself and serves them. */
export class ComposioRelay {
  readonly #entries = new Map<string, Entry>()
  readonly #byKey = new Map<string, string>()
  readonly #options: ComposioRelayOptions
  readonly #fetch: typeof fetch

  constructor(options: ComposioRelayOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? fetch
  }

  /**
   * Point a Composio MCP tool at the relay and start warming it.
   * @param tool - wire MCP tool of an agent.
   * @returns the same tool when it is not Composio's (or the relay has no origin), else a copy whose URL is the relay's and whose headers are empty.
   */
  rewrite(tool: OAIMcpTool): OAIMcpTool {
    if (tool.server_label !== this.#options.serverLabel || tool.transport.type !== 'http') return tool
    let host: string
    try {
      host = new URL(tool.transport.server_url).hostname
    } catch {
      return tool
    }
    if (host !== COMPOSIO_HOST) return tool
    const origin = this.#origin()
    if (origin === undefined) return tool
    const entry = this.#entryFor(tool.transport.server_url, tool.transport.headers ?? {})
    this.#warm(entry)
    return { ...tool, transport: { ...tool.transport, server_url: `${origin}${RELAY_PATH_PREFIX}${entry.token}`, headers: {} } }
  }

  /** Rewrite every tool of a list. */
  rewriteAll(tools: readonly OAIMcpTool[]): OAIMcpTool[] {
    return tools.map(tool => this.rewrite(tool))
  }

  /** Web-server handler for `/internal/mcp-relay/<token>`. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLocalPeer(req)) return reply(res, 403, { error: 'forbidden' })
    const path = (req.url ?? '').split('?')[0] ?? ''
    const token = path.startsWith(RELAY_PATH_PREFIX) ? path.slice(RELAY_PATH_PREFIX.length) : ''
    const entry = this.#entries.get(token)
    if (entry === undefined) return reply(res, 404, { error: 'not_found' })
    if (req.method === 'DELETE') {
      res.statusCode = 200
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE')
      return reply(res, 405, { error: 'method_not_allowed' })
    }
    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return reply(res, 400, rpcError(null, -32700, 'Parse error'))
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(item => this.#dispatch(entry, item)))).filter((item): item is Json => item !== undefined)
      if (out.length === 0) {
        res.statusCode = 202
        res.end()
        return
      }
      return reply(res, 200, out)
    }
    const answer = await this.#dispatch(entry, body)
    if (answer === undefined) {
      res.statusCode = 202
      res.end()
      return
    }
    return reply(res, 200, answer)
  }

  #origin(): string | undefined {
    try {
      return this.#options.origin()
    } catch {
      return undefined
    }
  }

  #entryFor(url: string, headers: Record<string, string>): Entry {
    const sorted = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const keyHash = createHash('sha256').update(JSON.stringify([url, sorted])).digest('hex')
    const known = this.#byKey.get(keyHash)
    const existing = known === undefined ? undefined : this.#entries.get(known)
    if (existing !== undefined) return existing
    const token = randomBytes(32).toString('base64url')
    const entry: Entry = {
      token, keyHash, url, headers: { ...headers }, sessionId: '', initializing: undefined,
      pages: new Map(), loaded: undefined, refreshing: new Map(),
    }
    this.#entries.set(token, entry)
    this.#byKey.set(keyHash, token)
    return entry
  }

  #warm(entry: Entry): void {
    void this.#toolsList(entry, '').catch((error: unknown) => {
      this.#options.warn?.(`composio relay warm-up failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async #dispatch(entry: Entry, raw: unknown): Promise<Json | undefined> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return rpcError(null, -32600, 'Invalid Request')
    const message = raw as Json
    const method = message['method']
    const hasId = Object.hasOwn(message, 'id') && message['id'] !== undefined
    const id = hasId ? message['id'] : null
    if (typeof method !== 'string') {
      // A response to a server request: nothing is forwarded.
      return hasId && (message['result'] !== undefined || message['error'] !== undefined) ? undefined : rpcError(id, -32600, 'Invalid Request')
    }
    if (!hasId) return undefined
    const params = message['params'] !== null && typeof message['params'] === 'object' ? message['params'] as Json : {}
    if (method === 'initialize') {
      const version = params['protocolVersion']
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof version === 'string' && version !== '' ? version : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agentry-composio-relay', version: '1' },
        },
      }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    try {
      if (method === 'tools/list') {
        const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : ''
        const page = await this.#toolsList(entry, cursor)
        return { jsonrpc: '2.0', id, result: page.result }
      }
      const answer = await this.#upstream(entry, { ...message, id }, method === 'tools/call' ? CALL_TIMEOUT_MS : LIST_TIMEOUT_MS)
      if (answer === null) return rpcError(id, -32603, 'The connector service sent no answer')
      return { ...answer, id }
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error)
      if (method === 'tools/call') {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Connector service error: ${text}` }], isError: true } }
      }
      return rpcError(id, -32603, text)
    }
  }

  async #toolsList(entry: Entry, cursor: string): Promise<CachedPage> {
    await this.#load(entry)
    const cached = entry.pages.get(cursor)
    if (cached !== undefined) {
      if (Date.now() - cached.at > REFRESH_AFTER_MS) {
        void this.#refresh(entry, cursor).catch(() => undefined)
      }
      return cached
    }
    return this.#refresh(entry, cursor)
  }

  #refresh(entry: Entry, cursor: string): Promise<CachedPage> {
    const running = entry.refreshing.get(cursor)
    if (running !== undefined) return running
    const task = (async (): Promise<CachedPage> => {
      const answer = await this.#upstream(entry, {
        jsonrpc: '2.0', id: `tools-list-${randomBytes(4).toString('hex')}`, method: 'tools/list',
        ...(cursor === '' ? {} : { params: { cursor } }),
      }, LIST_TIMEOUT_MS)
      if (answer === null) throw new Error('The connector service sent no tool list')
      const error = answer['error'] as { message?: unknown } | undefined
      if (error !== undefined) throw new Error(typeof error.message === 'string' ? error.message : 'The connector service refused the tool list')
      const page: CachedPage = { result: answer['result'] ?? { tools: [] }, at: Date.now() }
      entry.pages.set(cursor, page)
      void this.#persist(entry)
      return page
    })().finally(() => entry.refreshing.delete(cursor))
    entry.refreshing.set(cursor, task)
    return task
  }

  #load(entry: Entry): Promise<void> {
    const dir = this.#options.cacheDir
    if (dir === undefined) return Promise.resolve()
    entry.loaded ??= (async () => {
      try {
        const data = JSON.parse(await readFile(join(dir, `${entry.keyHash}.json`), 'utf8')) as { pages?: Record<string, CachedPage> }
        for (const [cursor, page] of Object.entries(data.pages ?? {})) {
          // Persisted pages are treated as stale: they serve at once and refresh in the background.
          if (!entry.pages.has(cursor) && page !== null && typeof page === 'object' && 'result' in page) entry.pages.set(cursor, { result: page.result, at: 0 })
        }
      } catch {
        // No cache file yet, or an unreadable one: start empty.
      }
    })()
    return entry.loaded
  }

  async #persist(entry: Entry): Promise<void> {
    const dir = this.#options.cacheDir
    if (dir === undefined) return
    try {
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${entry.keyHash}.json`)
      const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(temp, JSON.stringify({ pages: Object.fromEntries(entry.pages) }))
      await rename(temp, file)
    } catch (error: unknown) {
      this.#options.warn?.(`composio relay could not save its tool list: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Send one JSON-RPC request over the shared upstream session, re-initializing once when it expired. */
  async #upstream(entry: Entry, message: Json, timeoutMs: number): Promise<Json | null> {
    await this.#ensureInitialized(entry)
    try {
      return await this.#post(entry, message, timeoutMs)
    } catch (error: unknown) {
      if ((error as { status?: number }).status !== 404) throw error
      entry.sessionId = ''
      entry.initializing = undefined
      await this.#ensureInitialized(entry)
      return this.#post(entry, message, timeoutMs)
    }
  }

  #ensureInitialized(entry: Entry): Promise<void> {
    entry.initializing ??= (async () => {
      try {
        await this.#post(entry, {
          jsonrpc: '2.0', id: 'init', method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agentry-composio-relay', version: '1' } },
        }, LIST_TIMEOUT_MS, true)
        await this.#post(entry, { jsonrpc: '2.0', method: 'notifications/initialized' }, LIST_TIMEOUT_MS, true)
      } catch (error: unknown) {
        entry.initializing = undefined
        entry.sessionId = ''
        throw error
      }
    })()
    return entry.initializing
  }

  async #post(entry: Entry, message: Json, timeoutMs: number, initializing = false): Promise<Json | null> {
    const response = await this.#fetch(entry.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...entry.headers,
        ...(entry.sessionId === '' || initializing && message['method'] === 'initialize' ? {} : { 'mcp-session-id': entry.sessionId }),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const session = response.headers.get('mcp-session-id')
    if (session !== null && session !== '') entry.sessionId = session
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw Object.assign(new Error(`The connector service answered HTTP ${response.status}`), { status: response.status })
    }
    const text = await response.text()
    if (message['id'] === undefined) return null
    return parseUpstream(text, message['id'])
  }
}

/** Read a JSON or SSE reply and pick the frame answering `id`. */
export function parseUpstream(text: string, id: unknown): Json | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Json
  const frames: Json[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    try {
      frames.push(JSON.parse(data) as Json)
    } catch {
      // Not a JSON frame: skip it.
    }
  }
  return frames.findLast(frame => frame['id'] === id) ?? frames.at(-1) ?? null
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function isLocalPeer(req: IncomingMessage): boolean {
  const peer = req.socket.remoteAddress
  if (peer === undefined) return false
  if (peer === req.socket.localAddress) return true
  return peer === '::1' || peer === '127.0.0.1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
