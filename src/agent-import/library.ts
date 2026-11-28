/**
 * The owner's agent library sources (Agentry extension, owner scoped). A source is a label plus a GitHub
 * folder or gist link; the web app lists its agent files in the Library and adds one through
 * `POST /agents/import`, so nothing here saves an agent.
 *
 * - `GET /agents/library/sources`: `{ object: 'list', data: LibrarySource[] }`, oldest first.
 * - `POST /agents/library/sources` `{ label, url }`: add one (the link is read once to check it).
 *   400 `invalid_label`, `import_host_not_allowed`, `import_unrecognized`; 409 `library_source_exists`
 *   or `library_sources_limit` (10); 404/502 when the link cannot be read.
 * - `DELETE /agents/library/sources/{id}`.
 * - `GET /agents/library/sources/{id}/agents[?refresh=1]`: the source's agent files `{ name, description, url }`,
 *   read with the import fetch (same hosts, size and time limits) and cached for 10 minutes per link.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OwnerId } from '../auth/authenticator.ts'
import type { Route } from '../gateway.ts'
import { json, readBody } from '../http.ts'
import type { LibrarySource, Store } from '../store/store.ts'
import { fetchAllowed, type ImportCandidate, type ImportFetchDeps, listFolderCandidates, resolveImportTarget } from './fetch.ts'
import { type AgentDraft, ImportError, parseAgentDefinition, splitFrontMatter } from './parse.ts'

/** Most sources one owner may keep. */
export const MAX_LIBRARY_SOURCES = 10
/** Longest label. */
const MAX_LABEL = 40
/** How long a source's listing is reused. */
export const LIBRARY_CACHE_MS = 10 * 60_000
/** Most links kept in the listing cache. */
const MAX_CACHED = 200
/** The built-in library's label (the web app lists it first); no user source may take it. */
const RESERVED_LABEL = 'agentry'

export interface LibraryDeps extends ImportFetchDeps {
  store: () => Store
  /** Replaceable for tests. */
  now?: () => number
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { type: status >= 500 ? 'server_error' : 'invalid_request_error', message, code } })
}

function failImport(res: ServerResponse, error: ImportError): void {
  if (error.code === 'import_fetch_failed') fail(res, 502, error.code, error.message)
  else if (error.code === 'import_not_found') fail(res, 404, error.code, error.message)
  else fail(res, 400, error.code, error.message)
}

export class LibrarySourcesApi {
  readonly #cache = new Map<string, { at: number; data: ImportCandidate[] }>()

  constructor(private readonly deps: LibraryDeps) {}

  routes(): Route[] {
    return [
      { method: 'GET', pattern: '/agents/library/sources', handler: (_req, res, _url, _params, p) => this.list(res, p.owner) },
      { method: 'POST', pattern: '/agents/library/sources', handler: (req, res, _url, _params, p) => this.add(req, res, p.owner) },
      { method: 'DELETE', pattern: '/agents/library/sources/:source_id', handler: (_req, res, _url, params, p) => this.remove(res, params['source_id']!, p.owner) },
      { method: 'GET', pattern: '/agents/library/sources/:source_id/agents', handler: (_req, res, url, params, p) => this.agents(res, params['source_id']!, url.searchParams.get('refresh') === '1', p.owner) },
    ]
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async all(owner: OwnerId): Promise<LibrarySource[]> {
    return (await this.deps.store().librarySources.list(owner, { limit: MAX_LIBRARY_SOURCES + 1, order: 'asc' })).data
  }

  private async list(res: ServerResponse, owner: OwnerId): Promise<void> {
    json(res, 200, { object: 'list', data: await this.all(owner) })
  }

  private async add(req: IncomingMessage, res: ServerResponse, owner: OwnerId): Promise<void> {
    const body = await readBody(req)
    const label = typeof body['label'] === 'string' ? body['label'].trim().replace(/\s+/gu, ' ') : ''
    const url = typeof body['url'] === 'string' ? body['url'].trim() : ''
    if (label === '' || label.length > MAX_LABEL || label.toLowerCase() === RESERVED_LABEL) {
      fail(res, 400, 'invalid_label', `Enter a label of up to ${String(MAX_LABEL)} characters (not "Agentry").`)
      return
    }
    const existing = await this.all(owner)
    if (existing.length >= MAX_LIBRARY_SOURCES) {
      fail(res, 409, 'library_sources_limit', `You can keep up to ${String(MAX_LIBRARY_SOURCES)} sources. Remove one first.`)
      return
    }
    if (existing.some(s => s.label.toLowerCase() === label.toLowerCase())) {
      fail(res, 409, 'library_source_exists', `You already have a source named "${label}".`)
      return
    }
    try {
      this.checkLink(url)
      await this.read(url, true)
    } catch (error: unknown) {
      if (!(error instanceof ImportError)) throw error
      failImport(res, error)
      return
    }
    const source: LibrarySource = { id: `lsrc_${randomUUID().replaceAll('-', '')}`, object: 'library.source', label, url, created_at: Math.floor(this.now() / 1000) }
    json(res, 200, await this.deps.store().librarySources.create(owner, source))
  }

  private async remove(res: ServerResponse, id: string, owner: OwnerId): Promise<void> {
    if (!(await this.deps.store().librarySources.delete(owner, id))) {
      fail(res, 404, 'not_found', 'No such library source.')
      return
    }
    json(res, 200, { id, object: 'library.source.deleted', deleted: true })
  }

  private async agents(res: ServerResponse, id: string, refresh: boolean, owner: OwnerId): Promise<void> {
    const source = await this.deps.store().librarySources.get(owner, id)
    if (source === undefined) {
      fail(res, 404, 'not_found', 'No such library source.')
      return
    }
    try {
      json(res, 200, { object: 'list', source_id: source.id, data: await this.read(source.url, refresh) })
    } catch (error: unknown) {
      if (!(error instanceof ImportError)) throw error
      failImport(res, error)
    }
  }

  /**
   * Every source of `owner` with its agent files (cached like the route); a source that cannot be read has
   * `error` and no files. For the `library_search` and `library_add` tools.
   */
  async sourceAgents(owner: OwnerId): Promise<Array<{ source: LibrarySource; candidates: ImportCandidate[]; error?: string }>> {
    return Promise.all((await this.all(owner)).map(async (source) => {
      try {
        return { source, candidates: await this.read(source.url, false) }
      } catch (error: unknown) {
        if (!(error instanceof ImportError)) throw error
        return { source, candidates: [], error: error.message }
      }
    }))
  }

  /**
   * A source file's agent draft, fetched and parsed like `POST /agents/import`.
   * @param url - a candidate's link.
   * @param catalog - Host tool names.
   * @throws ImportError when the link is not allowed, cannot be read, or is not an agent definition.
   */
  async draft(url: string, catalog: ReadonlySet<string>): Promise<AgentDraft> {
    const target = resolveImportTarget(url, this.deps.hosts)
    if (target.kind !== 'file') throw new ImportError('import_unrecognized', 'That Library entry is a folder, not an agent file.')
    const draft = parseAgentDefinition(await fetchAllowed(this.deps, target.url), catalog).draft
    return { ...draft, metadata: { ...(draft.metadata ?? {}), source_url: url.slice(0, 512) } }
  }

  /** @throws ImportError unless `url` is a GitHub folder or a gist on an allowed host. */
  private checkLink(url: string): void {
    const target = resolveImportTarget(url, this.deps.hosts)
    if (target.kind === 'file' && !target.url.startsWith('https://gist.githubusercontent.com/')) {
      throw new ImportError('import_unrecognized', 'Use a link to a GitHub folder (…/tree/…) or a gist.')
    }
  }

  /** The link's agent files, from the cache unless `refresh` or older than 10 minutes. */
  private async read(url: string, refresh: boolean): Promise<ImportCandidate[]> {
    const hit = this.#cache.get(url)
    if (!refresh && hit !== undefined && this.now() - hit.at < LIBRARY_CACHE_MS) return hit.data
    const target = resolveImportTarget(url, this.deps.hosts)
    let data: ImportCandidate[]
    if (target.kind === 'folder') {
      data = await listFolderCandidates(this.deps, target)
    } else {
      const front = splitFrontMatter(await fetchAllowed(this.deps, target.url))?.data
      data = typeof front?.['name'] === 'string'
        ? [{ name: front['name'], description: typeof front['description'] === 'string' ? front['description'] : '', url }]
        : []
    }
    this.#cache.delete(url)
    this.#cache.set(url, { at: this.now(), data })
    if (this.#cache.size > MAX_CACHED) this.#cache.delete(this.#cache.keys().next().value!)
    return data
  }
}
