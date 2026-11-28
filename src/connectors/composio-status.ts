/**
 * The owner's connected Composio accounts, read with one `COMPOSIO_MANAGE_CONNECTIONS` call
 * (`action: "list"`). Ported from agentry-web `src/server/connector-status.ts` and
 * `connector-inventory.ts` when the key moved into the API.
 */

const TIMEOUT_MS = 8_000

/** One connected account of an app. */
export interface ConnectedAccount {
  id: string
  alias: string | null
  status: string
}

/** App slug to whether one account is active, and its accounts. */
export type ConnectedInventory = Record<string, { connected: boolean; accounts: ConnectedAccount[] }>

/** Why the accounts could not be read: Composio refused the key, or could not be reached. */
export type ConnectionProblem = 'rejected' | 'unavailable'

export type InventoryResult = { ok: true; inventory: ConnectedInventory } | { ok: false; reason: ConnectionProblem }

/** Reads the first JSON-RPC message from a plain JSON or SSE (`data:` lines) response body. */
export function parseRpcBody(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('data:') && line.slice(5).trim().startsWith('{')) return JSON.parse(line.slice(5))
  }
  throw new Error('no JSON-RPC message in response')
}

/**
 * Accounts per app from a `COMPOSIO_MANAGE_CONNECTIONS` list result.
 * @throws when the call did not succeed, so callers can tell "none" from "unknown".
 */
export function parseAccounts(message: unknown): ConnectedInventory {
  const rpc = message as { error?: unknown; result?: { isError?: boolean; content?: Array<{ text?: unknown }> } }
  const text = rpc.result?.content?.[0]?.text
  if (rpc.error || rpc.result?.isError || typeof text !== 'string') throw new Error('list call failed')
  const payload = JSON.parse(text) as { successful?: boolean; data?: { results?: Record<string, { accounts?: Array<{ id?: unknown; alias?: unknown; status?: unknown }> }> } }
  if (!payload.successful || !payload.data?.results) throw new Error('list call unsuccessful')
  const out: ConnectedInventory = {}
  for (const [slug, result] of Object.entries(payload.data.results)) {
    const accounts = (result.accounts ?? []).map(a => ({
      id: typeof a.id === 'string' ? a.id : '',
      alias: typeof a.alias === 'string' ? a.alias : null,
      status: typeof a.status === 'string' ? a.status : 'unknown',
    }))
    out[slug] = { connected: accounts.some(a => a.status === 'active'), accounts }
  }
  return out
}

/** Composio answers 401/403 when the consumer key is wrong or revoked. */
const refused = (res: Response): boolean => res.status === 401 || res.status === 403

/**
 * The owner's accounts for `slugs`, or why they could not be read. Never throws and never logs the key.
 * @param key - the owner's consumer key.
 * @param slugs - toolkit slugs to ask about.
 * @param url - Composio's MCP endpoint.
 * @param fetchImpl - replaceable for tests.
 */
export async function listInventory(key: string, slugs: readonly string[], url: string, fetchImpl: typeof fetch = fetch): Promise<InventoryResult> {
  const rpc = (body: unknown, session?: string): Promise<Response> => fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-consumer-api-key': key,
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  try {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agentry-api', version: '1' } },
    })
    if (!init.ok) return { ok: false, reason: refused(init) ? 'rejected' : 'unavailable' }
    await init.body?.cancel().catch(() => undefined)
    const session = init.headers.get('mcp-session-id') ?? undefined
    const res = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { toolkits: slugs.map(name => ({ name, action: 'list' })) } },
    }, session)
    if (!res.ok) return { ok: false, reason: refused(res) ? 'rejected' : 'unavailable' }
    return { ok: true, inventory: parseAccounts(parseRpcBody(await res.text())) }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
