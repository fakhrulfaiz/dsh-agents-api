/**
 * Fetching agent definitions from a link. Only `https` links on the allowed hosts (GitHub and gists by
 * default, `agents.importHosts`) are read, which keeps the server from being pointed at internal
 * addresses; redirects are followed only onto allowed hosts; bodies are capped at 256 KB and calls at 10 s.
 */
import type { GithubDeps } from '../skills/github.ts'
import { ImportError, splitFrontMatter } from './parse.ts'

/** Hosts links may point at by default. */
export const DEFAULT_IMPORT_HOSTS: readonly string[] = ['github.com', 'raw.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com']

export const MAX_IMPORT_BYTES = 256 * 1024
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const MAX_CANDIDATES = 200
const PARALLEL = 8

export interface ImportFetchDeps {
  github: GithubDeps
  /** Allowed hosts (`agents.importHosts`). */
  hosts: readonly string[]
}

/** One agent file of a GitHub folder. */
export interface ImportCandidate {
  name: string
  description: string
  url: string
}

export type ImportTarget =
  | { kind: 'file'; url: string }
  | { kind: 'folder'; owner: string; repo: string; ref: string; path: string }

function allowedUrl(raw: string, hosts: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ImportError('import_unrecognized', 'Enter a full https link to a file on GitHub or a gist.')
  }
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname.toLowerCase()) || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new ImportError('import_host_not_allowed', `Links must be https on ${hosts.join(', ')}.`)
  }
  return url
}

/**
 * Where a link's content is: a raw file URL, or a GitHub folder.
 * @throws ImportError `import_host_not_allowed` or `import_unrecognized`.
 */
export function resolveImportTarget(raw: string, hosts: readonly string[]): ImportTarget {
  const url = allowedUrl(raw.trim(), hosts)
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const host = url.hostname.toLowerCase()
  if (host === 'github.com') {
    const [owner, repo, kind, ref, ...rest] = parts
    if (owner && repo && ref && kind === 'blob' && rest.length > 0) {
      return { kind: 'file', url: `https://raw.githubusercontent.com/${[owner, repo, ref, ...rest].map(encodeURIComponent).join('/')}` }
    }
    if (owner && repo && ref && kind === 'tree') return { kind: 'folder', owner, repo, ref, path: rest.join('/') }
    throw new ImportError('import_unrecognized', 'Use a link to a file (…/blob/…) or a folder (…/tree/…) in a GitHub repository.')
  }
  if (host === 'gist.github.com') {
    const [user, id] = parts
    if (user && id) return { kind: 'file', url: `https://gist.githubusercontent.com/${encodeURIComponent(user)}/${encodeURIComponent(id)}/raw` }
    throw new ImportError('import_unrecognized', 'Use a link to a gist (gist.github.com/<user>/<id>).')
  }
  return { kind: 'file', url: url.toString() }
}

/** Read a body, refusing more than `MAX_IMPORT_BYTES`. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_IMPORT_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new ImportError('import_too_large', 'The file is larger than 256 KB.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * GET `url` (an allowed host), following redirects only onto allowed hosts.
 * @throws ImportError `import_host_not_allowed`, `import_not_found`, `import_too_large` or `import_fetch_failed`.
 */
export async function fetchAllowed(deps: ImportFetchDeps, raw: string, accept = 'text/plain, application/json, */*'): Promise<string> {
  let url = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response
    try {
      res = await deps.github.fetch(url, { redirect: 'manual', headers: { accept, 'user-agent': 'agentry-api' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      throw new ImportError('import_fetch_failed', 'The link could not be read (no answer within 10 seconds, or the host could not be reached).')
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => undefined)
      if (location === null) throw new ImportError('import_fetch_failed', 'The link redirected nowhere.')
      url = allowedUrl(new URL(location, url).toString(), deps.hosts).toString()
      continue
    }
    if (res.status === 404) throw new ImportError('import_not_found', 'Nothing was found at that link (is the repository public?).')
    if (!res.ok) throw new ImportError('import_fetch_failed', `The link answered ${String(res.status)}.`)
    return readCapped(res)
  }
  throw new ImportError('import_fetch_failed', 'The link redirected too many times.')
}

/** Run `work` over `items` with at most `limit` at a time. */
async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await work(items[index]!)
    }
  }))
  return out
}

/**
 * The agent files (`.md` with `name` in the front matter) of a GitHub folder, at most 200.
 * @throws ImportError when the folder cannot be listed.
 */
export async function listFolderCandidates(deps: ImportFetchDeps, folder: Extract<ImportTarget, { kind: 'folder' }>): Promise<ImportCandidate[]> {
  const path = folder.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const api = `${deps.github.apiBase}/repos/${encodeURIComponent(folder.owner)}/${encodeURIComponent(folder.repo)}/contents/${path}?ref=${encodeURIComponent(folder.ref)}`
  let res: Response
  try {
    res = await deps.github.fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentry-api' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new ImportError('import_fetch_failed', 'GitHub could not be reached.')
  }
  if (res.status === 404) throw new ImportError('import_not_found', 'That folder was not found (is the repository public?).')
  if (!res.ok) throw new ImportError('import_fetch_failed', `GitHub answered ${String(res.status)}.`)
  const entries = await res.json().catch(() => null) as Array<{ type?: string; name?: string; path?: string }> | null
  if (!Array.isArray(entries)) throw new ImportError('import_unrecognized', 'That link is a file, not a folder.')
  const files = entries.filter(e => e.type === 'file' && typeof e.name === 'string' && e.name.toLowerCase().endsWith('.md') && typeof e.path === 'string').slice(0, MAX_CANDIDATES)
  const read = await mapLimited(files, PARALLEL, async (entry) => {
    const pathParts = [folder.owner, folder.repo, folder.ref, ...entry.path!.split('/')].map(encodeURIComponent).join('/')
    try {
      const front = splitFrontMatter(await fetchAllowed(deps, `https://raw.githubusercontent.com/${pathParts}`))?.data
      if (typeof front?.['name'] !== 'string') return undefined
      const blob = [folder.owner, folder.repo, 'blob', folder.ref, ...entry.path!.split('/')].map(encodeURIComponent).join('/')
      return { name: front['name'], description: typeof front['description'] === 'string' ? front['description'] : '', url: `https://github.com/${blob}` }
    } catch {
      return undefined
    }
  })
  return read.filter((c): c is ImportCandidate => c !== undefined)
}
