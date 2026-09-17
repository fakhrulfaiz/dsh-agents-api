/**
 * HTTP helpers for the Agents API gateway.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Cursor options shared by list endpoints. */
export interface ListQuery {
  limit: number
  after?: string
  order?: 'asc' | 'desc'
}

/**
 * Read and parse a JSON object body. Malformed JSON and empty bodies become `{}`.
 * @param req - incoming request.
 * @returns the parsed object, or `{}` when the body is empty or not an object.
 */
export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks).toString('utf8')
  if (!body.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    // The request body is not JSON; OpenAI clients send objects, so treat it as empty.
    return {}
  }
}

/**
 * Write a JSON response and close the stream.
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param data - JSON-serializable body.
 */
export function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Write an OpenAI-shaped 404.
 * @param res - outgoing response.
 * @param message - human-readable detail.
 */
export function notFound(res: ServerResponse, message = 'Not found'): void {
  json(res, 404, {
    error: {
      type: 'invalid_request_error',
      message,
      code: 'resource_not_found',
    },
  })
}

/**
 * Flatten an unknown thrown value into a message string.
 * @param error - caught value.
 * @returns `Error.message` or `String(error)`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write an OpenAI-shaped 400.
 * @param res - outgoing response.
 * @param message - human-readable detail.
 */
export function badRequest(res: ServerResponse, message: string): void {
  json(res, 400, {
    error: {
      type: 'invalid_request_error',
      message,
      code: 'bad_request',
    },
  })
}

/**
 * Drop a trailing slash except for the root path.
 * @param pathname - URL pathname.
 * @returns pathname without a trailing slash.
 */
export function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

/**
 * Match `/agents/:agent_id` style patterns against a pathname.
 *
 * Parameter segments do not match an empty string. Callers must try more
 * specific routes (for example `/agents/sessions`) before `/agents/:agent_id`.
 *
 * @param pattern - route pattern with `:name` parameters.
 * @param pathname - request pathname relative to the API prefix.
 * @returns captured parameters, or `null` when the path does not match.
 */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const pParts = pattern.split('/').filter(Boolean)
  const aParts = pathname.split('/').filter(Boolean)
  if (pParts.length !== aParts.length) return null
  const params: Record<string, string> = {}
  for (const [i, p] of pParts.entries()) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- equal-length splits index in range
    const a = aParts[i]!
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a)
    } else if (p !== a) {
      return null
    }
  }
  return params
}

/**
 * Read a named route capture. Missing keys throw so a mismatched handler
 * cannot proceed with an empty id.
 * @param params - captures from `matchRoute`.
 * @param name - parameter name without the leading colon.
 * @returns the captured value.
 */
export function routeParam(params: Record<string, string>, name: string): string {
  const value = params[name]
  if (value === undefined) throw new Error(`Missing route parameter "${name}"`)
  return value
}

/**
 * Parse OpenAI list-cursor query parameters.
 * @param url - request URL.
 * @returns clamped limit plus optional `after` and `order`.
 */
export function listQuery(url: URL): ListQuery {
  const raw = parseInt(url.searchParams.get('limit') ?? '20', 10)
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 100) : 20
  const after = url.searchParams.get('after')
  const order = url.searchParams.get('order')
  return {
    limit,
    ...(after ? { after } : {}),
    ...(order === 'asc' || order === 'desc' ? { order } : {}),
  }
}

/**
 * Page an id-bearing list with `after`, `limit`, and `order`.
 * @param items - complete list in natural (oldest-first) order.
 * @param opts - cursor options.
 * @param createdAt - optional created-at accessor used when `order` is `desc`.
 * @returns an OpenAI list page.
 */
export function paginate<T extends { id: string }>(
  items: readonly T[],
  opts: ListQuery,
  createdAt?: (item: T) => number,
): { object: 'list'; data: T[]; first_id: string | null; last_id: string | null; has_more: boolean } {
  const order = opts.order ?? 'desc'
  let list = [...items]
  if (createdAt) {
    list.sort((a, b) => order === 'asc' ? createdAt(a) - createdAt(b) : createdAt(b) - createdAt(a))
  } else if (order === 'desc') {
    list.reverse()
  }
  if (opts.after) {
    const idx = list.findIndex(item => item.id === opts.after)
    if (idx !== -1) list = list.slice(idx + 1)
  }
  const paged = list.slice(0, opts.limit)
  return {
    object: 'list',
    data: paged,
    first_id: paged[0]?.id ?? null,
    last_id: paged[paged.length - 1]?.id ?? null,
    has_more: list.length > opts.limit,
  }
}
