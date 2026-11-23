/**
 * Connect links in tool outputs. When a connected-apps tool answers with a
 * sign-in link, the output item carries `connect_request` so clients show a
 * Connect button instead of a raw URL the model may have to repeat.
 */

/** A pending app connection. */
export interface ConnectRequest {
  /** App slug when the output names it. */
  toolkit: string | null
  /** The sign-in link. */
  url: string
  status: 'initiated' | 'active' | 'unknown'
}

const LINK = /https:\/\/connect\.composio\.dev\/link\/[A-Za-z0-9_-]+/u

/** @returns whether `value` is a Composio Connect Link (https, host connect.composio.dev, path under /link/). */
export function isConnectLink(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'connect.composio.dev' && url.pathname.startsWith('/link/')
  } catch {
    return false
  }
}

const TOOLKIT_KEYS = ['toolkit', 'toolkit_slug', 'toolkitSlug', 'app', 'app_name']

/**
 * Depth-first search for a connect link and its nearest toolkit and status.
 * @returns the first match.
 */
function search(value: unknown, toolkit: string | null, status: string | undefined): ConnectRequest | undefined {
  if (typeof value === 'string') return isConnectLink(value) ? { toolkit, url: value, status: statusOf(status) } : undefined
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = search(entry, toolkit, status)
      if (found) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const own = TOOLKIT_KEYS.map(k => record[k]).find((v): v is string => typeof v === 'string' && v !== '')
  const ownStatus = typeof record['status'] === 'string' ? record['status'] : status
  for (const entry of Object.values(record)) {
    const found = search(entry, own ?? toolkit, ownStatus)
    if (found) return found
  }
  return undefined
}

function statusOf(value: string | undefined): ConnectRequest['status'] {
  const lower = value?.toLowerCase()
  return lower === 'initiated' || lower === 'active' ? lower : 'unknown'
}

/**
 * @param output - a tool output as saved on the item (JSON text or plain text).
 * @returns the connect request it carries, or `undefined`.
 */
export function connectRequestFrom(output: string): ConnectRequest | undefined {
  if (!output.includes('connect.composio.dev')) return undefined
  try {
    const parsed: unknown = JSON.parse(output)
    const found = search(parsed, null, undefined)
    if (found) return found
  } catch {
    // Plain text: fall through to the text scan.
  }
  const match = LINK.exec(output)
  return match ? { toolkit: null, url: match[0], status: 'unknown' } : undefined
}
