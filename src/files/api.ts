/**
 * `/agents/files` routes: upload, content, and delete of staged files.
 *
 * Every read and write is scoped to the authenticated owner; another owner's id answers 404. Without an
 * `uploads.dir` the upload route answers 501 `uploads_disabled`.
 */

import type { ServerResponse } from 'node:http'
import type { OwnerId } from '../auth/authenticator.ts'
import { AgentsApiRequestError } from '../errors.ts'
import type { Route } from '../gateway.ts'
import { json, notFound, routeParam, writeRequestError } from '../http.ts'
import { directorySegment } from '../environment/local.ts'
import type { FileRow, Store } from '../store/store.ts'
import type { UploadLimits } from './config.ts'
import { serveFile, type FileSource, type ServedFile } from './content.ts'
import { FileNotFoundError, stagingKey, type FileStore } from './file-store.ts'
import { handleUpload } from './upload.ts'

/** Staging bytes and limits; present when `uploads.dir` is configured. */
export interface FilesRuntime {
  staging: FileStore
  limits: UploadLimits
}

/** What `FilesApi` needs from the gateway. */
export interface FilesApiDeps {
  store: () => Store
  runtime: FilesRuntime | undefined
  /** Content sources tried in order; the first that has the file for the owner serves it. */
  sources: FileSource[]
  warn: (message: string) => void
}

/** Wire error for uploads that are not configured. */
function disabled(): AgentsApiRequestError {
  return new AgentsApiRequestError('File uploads are not enabled on this server (set uploads.dir)', 501, 'uploads_disabled')
}

/**
 * Source of staged and attached upload rows.
 * @param deps - store, staging bytes, and a reader of attached bytes.
 * @returns the source.
 */
export function uploadedFileSource(deps: {
  store: () => Store
  staging: FileStore | undefined
  attached: (row: FileRow) => Promise<ServedFile | undefined>
}): FileSource {
  return {
    async open(owner, id) {
      const row = await deps.store().files.get(id, owner)
      if (row === undefined) return undefined
      if (row.status === 'attached') return deps.attached(row)
      if (deps.staging === undefined) return undefined
      const staging = deps.staging
      const key = stagingKey(directorySegment(owner, 'owner'), row.id)
      try {
        // Open before the headers are sent so a missing object answers 404, not a broken 200.
        const stream = await staging.stream(key)
        return { name: row.name, mediaType: row.mediaType, bytes: row.bytes, body: () => stream }
      } catch (error: unknown) {
        if (error instanceof FileNotFoundError) return undefined
        throw error
      }
    },
  }
}

/** The file routes. */
export class FilesApi {
  /** @param deps - store, staging, sources, and logger. */
  constructor(private readonly deps: FilesApiDeps) {}

  /** @returns the routes, to be placed before `/agents/:agent_id`. */
  routes(): Route[] {
    return [
      {
        method: 'POST',
        pattern: '/agents/files',
        handler: async (req, res, _url, _params, principal) => {
          const { runtime } = this.deps
          if (runtime === undefined) {
            writeRequestError(res, disabled())
            req.resume()
            return
          }
          await handleUpload(req, res, principal.owner, { store: this.deps.store(), staging: runtime.staging, limits: runtime.limits, warn: this.deps.warn })
        },
      },
      {
        method: 'GET',
        pattern: '/agents/files/:file_id/content',
        handler: (req, res, _url, params, principal) => this.content(req, res, routeParam(params, 'file_id'), principal.owner),
      },
      {
        method: 'DELETE',
        pattern: '/agents/files/:file_id',
        handler: (_req, res, _url, params, principal) => this.remove(res, routeParam(params, 'file_id'), principal.owner),
      },
    ]
  }

  private async content(req: Parameters<Route['handler']>[0], res: ServerResponse, id: string, owner: OwnerId): Promise<void> {
    for (const source of this.deps.sources) {
      let file: ServedFile | undefined
      try {
        file = await source.open(owner, id)
      } catch (error: unknown) {
        if (error instanceof AgentsApiRequestError) {
          writeRequestError(res, error)
          return
        }
        throw error
      }
      if (file !== undefined) {
        await serveFile(req, res, file)
        return
      }
    }
    notFound(res, `File "${id}" not found`)
  }

  private async remove(res: ServerResponse, id: string, owner: OwnerId): Promise<void> {
    const removed = await this.deps.store().files.deleteStaged(id, owner)
    if (removed === undefined) {
      notFound(res, `File "${id}" not found`)
      return
    }
    if (removed === 'attached') {
      writeRequestError(res, new AgentsApiRequestError('The file is attached to a message and cannot be removed', 409, 'file_attached'))
      return
    }
    if (this.deps.runtime !== undefined) {
      try {
        await this.deps.runtime.staging.delete(stagingKey(directorySegment(owner, 'owner'), id))
      } catch (error: unknown) {
        // The row is gone; the sweeper removes bytes with no staged row.
        this.deps.warn(`agents-api: could not remove staged bytes of ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    json(res, 200, { id, object: 'file.deleted', deleted: true })
  }
}
