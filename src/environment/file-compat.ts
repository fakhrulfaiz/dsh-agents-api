/**
 * Environment files on the wire, in the OpenAI Agents API's shape (as the OpenAI Python SDK
 * defines it): `agent.environment.file` objects with absolute `/workspace/...` paths and
 * `size_bytes`, listed with `limit`, `order`, `page` and `path` and answered as a token page
 * (`data`, `has_more`, `next`); created from `{ type: 'inline', path, data }` (base64) or
 * `{ type: 'file_id', path, file_id }`. The earlier `{ path, content | content_base64 }` write
 * body is still accepted.
 */

export interface SdkEnvironmentFile {
  object: 'agent.environment.file'
  environment_id: string
  path: string
  size_bytes: number
}

export interface FileListQuery {
  limit: number
  order: 'asc' | 'desc'
  /** Opaque token from the previous page. */
  page?: string
  /** Absolute workspace directory to restrict the listing to. */
  path?: string
}

export const DEFAULT_FILE_LIMIT = 20
export const WORKSPACE = '/workspace'

/** The absolute workspace path of a workspace-relative path. */
export const absoluteFilePath = (relative: string): string => `${WORKSPACE}/${relative.replace(/^\/+/u, '')}`

/** A workspace-relative path from an absolute `/workspace/...` path or an already relative one. */
export const relativeFilePath = (path: string): string => {
  const trimmed = path.trim()
  if (trimmed === WORKSPACE) return ''
  return trimmed.startsWith(`${WORKSPACE}/`) ? trimmed.slice(WORKSPACE.length + 1) : trimmed.replace(/^\/+/u, '')
}

/**
 * @param url - request URL.
 * @returns the parsed list query, or an error message for an invalid `limit`, `order` or `page`.
 */
export function parseFileListQuery(url: URL): FileListQuery | { error: string } {
  const params = url.searchParams
  const limitText = params.get('limit')
  const limit = limitText === null || limitText === '' ? DEFAULT_FILE_LIMIT : Number(limitText)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: '"limit" must be a whole number from 1 to 100' }
  const order = params.get('order') ?? 'desc'
  if (order !== 'asc' && order !== 'desc') return { error: '"order" must be "asc" or "desc"' }
  const page = params.get('page')
  if (page !== null && page !== '' && decodePage(page) === undefined) return { error: 'invalid "page" token' }
  const path = params.get('path')
  return { limit, order, ...(page !== null && page !== '' ? { page } : {}), ...(path !== null && path !== '' ? { path } : {}) }
}

const encodePage = (absolute: string): string => Buffer.from(JSON.stringify({ p: absolute }), 'utf8').toString('base64url')

function decodePage(token: string): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { p?: unknown }
    return typeof parsed.p === 'string' ? parsed.p : undefined
  } catch {
    return undefined
  }
}

/** Case-sensitive comparison by path components, as the SDK documents; a path sorts before its children. */
function compareComponents(a: string, b: string): number {
  const left = a.split('/')
  const right = b.split('/')
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const x = left[i] as string
    const y = right[i] as string
    if (x !== y) return x < y ? -1 : 1
  }
  return left.length - right.length
}

/**
 * Filter, order and page workspace-relative file paths.
 * @param relativePaths - every file in the workspace, workspace-relative.
 * @param query - parsed list query.
 * @returns the page's workspace-relative paths, whether more remain, and the token for the next page.
 */
export function selectFilePage(relativePaths: readonly string[], query: FileListQuery): { items: string[]; has_more: boolean; next?: string } {
  const directory = query.path === undefined ? '' : relativeFilePath(query.path).replace(/\/+$/u, '')
  const sign = query.order === 'asc' ? 1 : -1
  let rows = relativePaths
    .map(relative => ({ relative, absolute: absoluteFilePath(relative) }))
    .filter(row => directory === '' || row.relative === directory || row.relative.startsWith(`${directory}/`))
    .sort((a, b) => sign * compareComponents(a.absolute, b.absolute))
  const after = query.page === undefined ? undefined : decodePage(query.page)
  if (after !== undefined) rows = rows.filter(row => sign * compareComponents(row.absolute, after) > 0)
  const items = rows.slice(0, query.limit)
  const has_more = rows.length > items.length
  const last = items[items.length - 1]
  return { items: items.map(row => row.relative), has_more, ...(has_more && last !== undefined ? { next: encodePage(last.absolute) } : {}) }
}

/** A file create body, parsed. `file_id` is returned as such so the caller can answer it. */
export type FileWrite =
  | { kind: 'bytes'; path: string; bytes: Buffer }
  | { kind: 'file_id'; path: string; fileId: string }
  | { error: string }

/**
 * @param body - parsed request body: the SDK's `{type, path, data | file_id}` or the earlier `{path, content | content_base64}`.
 * @returns the destination (workspace-relative) and bytes, or an error message.
 */
export function parseFileWrite(body: unknown): FileWrite {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'request body must be a JSON object' }
  const record = body as Record<string, unknown>
  if (typeof record['path'] !== 'string' || record['path'].trim() === '') return { error: 'Field "path" is required' }
  const path = relativeFilePath(record['path'])
  if (path === '') return { error: 'Field "path" must name a file inside /workspace' }
  if (record['type'] === 'file_id') {
    return typeof record['file_id'] === 'string' && record['file_id'] !== '' ? { kind: 'file_id', path, fileId: record['file_id'] } : { error: 'Field "file_id" is required when type is "file_id"' }
  }
  if (typeof record['data'] === 'string') return { kind: 'bytes', path, bytes: Buffer.from(record['data'], 'base64') }
  if (typeof record['content'] === 'string') return { kind: 'bytes', path, bytes: Buffer.from(record['content'], 'utf8') }
  if (typeof record['content_base64'] === 'string') return { kind: 'bytes', path, bytes: Buffer.from(record['content_base64'], 'base64') }
  return { error: 'Field "data" (base64), "content" or "content_base64" is required' }
}
