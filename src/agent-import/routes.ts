/**
 * `POST /agents/import` (Agentry extension): an agent definition from a link (GitHub or gist) or
 * pasted text, as a draft for the agent form. Nothing is saved.
 *
 * - `{ text }` or a file link → `{ object: 'agent.import.draft', draft, source: { url?, format }, notes }`.
 * - A GitHub folder link → `{ object: 'agent.import.candidates', data: [{ name, description, url }] }`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route } from '../gateway.ts'
import { json, readBody } from '../http.ts'
import { fetchAllowed, type ImportFetchDeps, listFolderCandidates, MAX_IMPORT_BYTES, resolveImportTarget } from './fetch.ts'
import { ImportError, parseAgentDefinition } from './parse.ts'

export interface AgentImportDeps extends ImportFetchDeps {
  /** Host tool names (the `GET /agents/tools` catalog). */
  catalog: () => Promise<ReadonlySet<string>>
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { type: status >= 500 ? 'server_error' : 'invalid_request_error', message, code } })
}

export class AgentImportApi {
  constructor(private readonly deps: AgentImportDeps) {}

  routes(): Route[] {
    return [{ method: 'POST', pattern: '/agents/import', handler: (req, res) => this.import(req, res) }]
  }

  private async import(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    const url = typeof body['url'] === 'string' && body['url'].trim() !== '' ? body['url'].trim() : undefined
    const text = typeof body['text'] === 'string' && body['text'].trim() !== '' ? body['text'] : undefined
    if ((url === undefined) === (text === undefined)) {
      fail(res, 400, 'bad_request', 'Send either "url" or "text".')
      return
    }
    try {
      if (text !== undefined) {
        if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new ImportError('import_too_large', 'The text is larger than 256 KB.')
        const parsed = parseAgentDefinition(text, await this.deps.catalog())
        json(res, 200, { object: 'agent.import.draft', draft: parsed.draft, source: { format: parsed.format }, notes: parsed.notes })
        return
      }
      const target = resolveImportTarget(url!, this.deps.hosts)
      if (target.kind === 'folder') {
        json(res, 200, { object: 'agent.import.candidates', data: await listFolderCandidates(this.deps, target) })
        return
      }
      const parsed = parseAgentDefinition(await fetchAllowed(this.deps, target.url), await this.deps.catalog())
      parsed.draft.metadata = { ...(parsed.draft.metadata ?? {}), source_url: url!.slice(0, 512) }
      json(res, 200, { object: 'agent.import.draft', draft: parsed.draft, source: { url, format: parsed.format }, notes: parsed.notes })
    } catch (error: unknown) {
      if (!(error instanceof ImportError)) throw error
      if (error.code === 'import_fetch_failed') fail(res, 502, error.code, error.message)
      else if (error.code === 'import_not_found') fail(res, 404, error.code, error.message)
      else fail(res, 400, error.code, error.message)
    }
  }
}
