/**
 * Attach staged files to a user message.
 *
 * `validate` has no side effects. `attach` claims the rows, stores each file in the DSH attachment store
 * (image blocks only on vision routes), copies it into `<workspace>/uploads/`, and returns the content blocks and
 * the agent-facing note. The caller queues the message, then calls `commit`; when queueing fails it calls
 * `rollback`, which returns the rows to `staged`.
 */

import { rm } from 'node:fs/promises'
import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { OwnerId } from '../auth/authenticator.ts'
import { directorySegment } from '../environment/local.ts'
import { AgentsApiRequestError } from '../errors.ts'
import type { FileRow, Store } from '../store/store.ts'
import type { AttachmentsPort } from './attached.ts'
import type { UploadLimits } from './config.ts'
import { FileNotFoundError, stagingKey, type FileStore } from './file-store.ts'
import { ATTACHMENT_NOTE_PREFIX } from './note.ts'
import { isRaster } from './sniff.ts'
import { copyIntoUploads, type WorkspaceCopy } from './workspace-copy.ts'

/** The result of `AttachmentIngest.attach`. */
export interface AttachedFiles {
  /** `image` and `file` content blocks in upload order. */
  blocks: Array<ImageBlock | FileBlock>
  /** One text block telling the agent where the copies are; starts with `ATTACHMENT_NOTE_PREFIX`. */
  note: string
  /** Delete the staging bytes after the message was queued. Failures are logged. */
  commit(): Promise<void>
  /** Undo `attach` after the message could not be queued: remove workspace copies and unclaim the rows. */
  rollback(): Promise<void>
}

/** What `AttachmentIngest` needs from the gateway. */
export interface IngestDeps {
  store: () => Store
  staging: FileStore | undefined
  limits: UploadLimits
  attachments: () => AttachmentsPort | undefined
  warn: (message: string) => void
}

/**
 * @param bytes - size.
 * @returns a short human size such as `12 KB`.
 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Validates, attaches, and releases staged files. */
export class AttachmentIngest {
  /** @param deps - store, staging bytes, limits, and the attachment service. */
  constructor(private readonly deps: IngestDeps) {}

  /**
   * Check file ids before anything is created or claimed.
   * @param owner - authenticated caller.
   * @param ids - file ids in message order.
   * @returns the `staged` rows in `ids` order.
   * @throws AgentsApiRequestError 501 `uploads_disabled`; 400 `duplicate_file_id` or `too_many_files`; 404 `file_not_found` (unknown or another owner's id); 409 `file_already_attached`; 413 `message_too_large`.
   */
  async validate(owner: OwnerId, ids: readonly string[]): Promise<FileRow[]> {
    if (ids.length === 0) return []
    const { limits } = this.deps
    if (this.deps.staging === undefined) throw new AgentsApiRequestError('File uploads are not enabled on this server (set uploads.dir)', 501, 'uploads_disabled')
    if (new Set(ids).size !== ids.length) throw new AgentsApiRequestError('The same file id is used more than once', 400, 'duplicate_file_id')
    if (ids.length > limits.maxFilesPerMessage) {
      throw new AgentsApiRequestError(`A message can carry at most ${String(limits.maxFilesPerMessage)} files`, 400, 'too_many_files')
    }
    const found = new Map((await this.deps.store().files.getMany(owner, ids)).map(row => [row.id, row]))
    const rows = ids.map((id) => {
      const row = found.get(id)
      if (row === undefined) throw new AgentsApiRequestError(`File "${id}" not found`, 404, 'file_not_found')
      if (row.status !== 'staged') throw new AgentsApiRequestError(`File "${id}" is already attached to a message`, 409, 'file_already_attached')
      return row
    })
    if (rows.reduce((sum, row) => sum + row.bytes, 0) > limits.maxMessageBytes) {
      throw new AgentsApiRequestError(`The files of one message can total at most ${String(limits.maxMessageBytes)} bytes`, 413, 'message_too_large')
    }
    return rows
  }

  /**
   * Claim, store, and copy the files.
   * @param args - `owner`, the `sessionId` and workspace `cwd` the message goes to, the `ids`, and `supportsImages`, which decides whether rasters are sent as images.
   * @returns the blocks, note, and commit and rollback callbacks.
   * @throws AgentsApiRequestError as `validate`, plus 409 `file_already_attached` when a concurrent send claimed a file first, 409 `uploads_unsafe` for an unsafe workspace, 404 `file_not_found` when staged bytes are gone, 503 `attachments_unavailable`. Any failure leaves the rows `staged` and removes copies made so far.
   */
  async attach(args: { owner: OwnerId; sessionId: string; cwd: string; ids: readonly string[]; supportsImages: () => Promise<boolean>; copy?: (name: string, source: AsyncIterable<Uint8Array>) => Promise<WorkspaceCopy> }): Promise<AttachedFiles> {
    const { owner, sessionId, cwd, ids } = args
    const { store, staging } = this.deps
    const rows = await this.validate(owner, ids)
    const claimed = await store().files.claim(owner, ids, sessionId)
    if (claimed === undefined) throw new AgentsApiRequestError('A file is already attached to a message', 409, 'file_already_attached')
    const copies: WorkspaceCopy[] = []
    const rollback = async (): Promise<void> => {
      await Promise.all(copies.splice(0).map(copy => (copy.remove ? copy.remove() : rm(copy.absolute, { force: true })).catch(() => undefined)))
      await store().files.release(owner, ids)
    }
    try {
      const attachments = this.deps.attachments()
      if (attachments === undefined) throw new AgentsApiRequestError('The attachment store is not available', 503, 'attachments_unavailable')
      const vision = rows.some(row => isRaster(row.mediaType)) && await args.supportsImages()
      const segment = directorySegment(owner, 'owner')
      const blocks: AttachedFiles['blocks'] = []
      const notes: string[] = []
      for (const row of rows) {
        const key = stagingKey(segment, row.id)
        const bytes = async function* (): AsyncGenerator<Uint8Array> {
          yield* await openStaged(staging!, key, row.id)
        }
        let block: ImageBlock | FileBlock | undefined
        let snapshot: NonNullable<FileRow['attachment']> | undefined
        if (vision && isRaster(row.mediaType)) {
          try {
            const ref = await attachments.saveImage({ data: await staging!.get(key), mediaType: row.mediaType as 'image/png', name: row.name })
            block = { type: 'image', attachment: ref }
            snapshot = { kind: 'image', ref }
          } catch (error: unknown) {
            if (error instanceof FileNotFoundError) throw new AgentsApiRequestError(`File "${row.id}" not found`, 404, 'file_not_found')
            // DSH could not decode or admit the image (corrupt, too large, too many pixels): send it as a plain file instead.
            this.deps.warn(`agents-api: image ${row.id} sent as a file: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (block === undefined || snapshot === undefined) {
          const ref = await attachments.saveFileStream({ data: bytes(), name: row.name })
          block = { type: 'file', attachment: ref }
          snapshot = { kind: 'file', ref }
        }
        const copy = await (args.copy ? args.copy(row.name, bytes()) : copyIntoUploads(cwd, row.name, bytes()))
        copies.push(copy)
        await store().files.markAttached(row.id, owner, { attachment: snapshot, workspacePath: copy.relative })
        blocks.push(block)
        notes.push(`${copy.relative} (${row.mediaType}, ${humanSize(row.bytes)})`)
      }
      return {
        blocks,
        note: `${ATTACHMENT_NOTE_PREFIX} ${notes.join('; ')}`,
        commit: async () => {
          for (const row of rows) {
            try {
              await staging!.delete(stagingKey(segment, row.id))
            } catch (error: unknown) {
              // The sweeper removes staged bytes whose row is no longer `staged`.
              this.deps.warn(`agents-api: could not remove staged bytes of ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        },
        rollback,
      }
    } catch (error: unknown) {
      await rollback()
      throw error
    }
  }
}

/**
 * Open staged bytes, mapping a missing object to the wire error.
 * @param staging - staging store.
 * @param key - storage key.
 * @param id - file id, for the message.
 * @returns the byte stream.
 * @throws AgentsApiRequestError 404 `file_not_found` when the bytes are gone.
 */
async function openStaged(staging: FileStore, key: string, id: string): Promise<AsyncIterable<Uint8Array>> {
  try {
    return await staging.stream(key)
  } catch (error: unknown) {
    if (error instanceof FileNotFoundError) throw new AgentsApiRequestError(`File "${id}" not found`, 404, 'file_not_found')
    throw error
  }
}
