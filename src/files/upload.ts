/**
 * `POST /agents/files`: stream one multipart file part into the staging `FileStore`.
 *
 * Nothing is buffered beyond the first `SNIFF_BYTES`. The size limit is enforced three ways: an early 413 from
 * `Content-Length`, busboy's `fileSize` limit while streaming, and the store's own counter. A rejected upload
 * leaves no bytes and no row.
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import busboy from 'busboy'
import type { Readable } from 'node:stream'
import type { OwnerId } from '../auth/authenticator.ts'
import { directorySegment } from '../environment/local.ts'
import { json } from '../http.ts'
import type { FileRow, Store } from '../store/store.ts'
import type { UploadLimits } from './config.ts'
import { FileTooLargeError, stagingKey, type FileStore } from './file-store.ts'
import { sanitizeFileName } from './names.ts'
import { classifyUpload, SNIFF_BYTES, UploadRejection } from './sniff.ts'

/** Multipart framing allowed on top of `maxFileBytes` when checking `Content-Length` (boundaries, headers, `purpose`). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024

/** Wire file object returned by `POST /agents/files`. */
export interface WireFile {
  id: string
  object: 'file'
  bytes: number
  created_at: number
  filename: string
  purpose: 'user_data'
  media_type: string
  status: 'staged' | 'attached'
}

/**
 * @param row - file record.
 * @returns its wire object.
 */
export function toWireFile(row: FileRow): WireFile {
  return {
    id: row.id,
    object: 'file',
    bytes: row.bytes,
    created_at: Math.floor(row.createdAt.getTime() / 1000),
    filename: row.name,
    purpose: 'user_data',
    media_type: row.mediaType,
    status: row.status,
  }
}

/**
 * Write an error and close the connection, discarding the rest of an unread body.
 * @param req - request whose body is abandoned.
 * @param res - response.
 * @param rejection - status and code.
 */
function reject(req: IncomingMessage, res: ServerResponse, rejection: UploadRejection): void {
  if (res.headersSent) return
  const body = JSON.stringify({ error: { type: 'invalid_request_error', message: rejection.message, code: rejection.code } })
  res.writeHead(rejection.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' })
  res.end(body, () => {
    req.destroy()
  })
}

/** Everything the upload handler needs. */
export interface UploadDeps {
  store: Store
  staging: FileStore
  limits: UploadLimits
  /** Reports an internal failure; the response carries a generic message. */
  warn: (message: string) => void
}

/**
 * Handle one upload.
 * @param req - request with a `multipart/form-data` body: one `file` part and an optional `purpose` field (`user_data`).
 * @param res - response; 201 with the file object, or 400 `invalid_file`, 413 `file_too_large`, 415 `unsupported_media_type`, 429 `staging_quota_exceeded`.
 * @param owner - authenticated caller; the file is staged for them alone.
 * @param deps - store, staging bytes, limits, and logger.
 */
export async function handleUpload(req: IncomingMessage, res: ServerResponse, owner: OwnerId, deps: UploadDeps): Promise<void> {
  const { limits } = deps
  const declaredLength = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length'])
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > limits.maxFileBytes + MULTIPART_OVERHEAD_BYTES) {
    reject(req, res, new UploadRejection(`the upload exceeds ${String(limits.maxFileBytes)} bytes`, 413, 'file_too_large'))
    return
  }
  const staged = await deps.store.files.stagedBytes(owner)
  // `Content-Length` includes multipart framing, so only what exceeds the framing allowance counts here; the check after storing is exact.
  if (staged >= limits.maxStagedBytesPerOwner || staged + Math.max(0, (declaredLength ?? 0) - MULTIPART_OVERHEAD_BYTES) > limits.maxStagedBytesPerOwner) {
    reject(req, res, quotaRejection())
    return
  }
  let row: FileRow
  try {
    row = await receive(req, owner, deps)
  } catch (error: unknown) {
    if (error instanceof UploadRejection) {
      reject(req, res, error)
      return
    }
    deps.warn(`agents-api: upload failed: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.headersSent) json(res, 500, { error: { type: 'server_error', message: 'The upload could not be stored', code: 'upload_failed' } })
    return
  }
  json(res, 201, toWireFile(row))
}

/** @returns the 429 for an owner whose staged bytes are at the quota. */
function quotaRejection(): UploadRejection {
  return new UploadRejection('too many staged bytes; send or remove the files you already uploaded', 429, 'staging_quota_exceeded')
}

/**
 * Parse the body, store the bytes, and insert the row.
 * @param req - request.
 * @param owner - caller.
 * @param deps - handler dependencies.
 * @returns the staged row.
 * @throws UploadRejection for a client error; anything else is an internal failure. No bytes or row stay behind on any failure.
 */
function receive(req: IncomingMessage, owner: OwnerId, deps: UploadDeps): Promise<FileRow> {
  const { limits, staging, store } = deps
  if (!/^multipart\/form-data/iu.test(req.headers['content-type'] ?? '')) {
    return Promise.reject(new UploadRejection('send multipart/form-data with one "file" part', 400, 'invalid_file'))
  }
  let parser: ReturnType<typeof busboy>
  try {
    parser = busboy({ headers: req.headers, limits: { fileSize: limits.maxFileBytes + 1, files: 1, fields: 4, fieldSize: 256, parts: 6, headerPairs: 32 }, defParamCharset: 'utf8' })
  } catch {
    // busboy rejects a multipart header without a boundary.
    return Promise.reject(new UploadRejection('the multipart body is malformed', 400, 'invalid_file'))
  }
  const ownerSegment = directorySegment(owner, 'owner')
  return new Promise<FileRow>((resolve, rejectWith) => {
    let settled = false
    let pending: UploadRejection | undefined
    let stored: Promise<FileRow> | undefined
    let purpose = 'user_data'

    /** Remove the bytes and row of a stored upload that will not be used. */
    async function discard(row: FileRow): Promise<void> {
      await staging.delete(stagingKey(ownerSegment, row.id)).catch(() => undefined)
      await store.files.deleteStaged(row.id, owner).catch(() => undefined)
    }
    function abort(error: unknown): void {
      if (settled) return
      settled = true
      rejectWith(error instanceof FileTooLargeError ? new UploadRejection(`the file exceeds ${String(limits.maxFileBytes)} bytes`, 413, 'file_too_large') : error)
    }
    const flag = (message: string): void => {
      pending ??= new UploadRejection(message, 400, 'invalid_file')
    }

    parser.on('field', (name, value) => {
      if (name === 'purpose') purpose = value
    })
    parser.on('filesLimit', () => {
      flag('send exactly one file per request')
    })
    parser.on('partsLimit', () => {
      flag('the multipart body has too many parts')
    })
    parser.on('file', (field, stream, info) => {
      const name = sanitizeFileName(info.filename ?? '')
      if (field !== 'file' || stored !== undefined || name === undefined) {
        flag(field !== 'file' ? 'the file part must be named "file"' : stored !== undefined ? 'send exactly one file per request' : 'the file needs a usable name')
        stream.resume()
        return
      }
      const id = `file_${randomBytes(12).toString('hex')}`
      let mediaType = ''
      const source = sniffed(stream, name, info.mimeType, limits, (type) => {
        mediaType = type
      })
      stored = staging.put(stagingKey(ownerSegment, id), source, { maxBytes: limits.maxFileBytes }).then(async (result) => {
        const row: FileRow = {
          id,
          ownerId: owner,
          name,
          mediaType,
          bytes: result.bytes,
          sha256: result.sha256,
          status: 'staged',
          sessionId: null,
          attachment: null,
          workspacePath: null,
          createdAt: new Date(),
          attachedAt: null,
        }
        try {
          await store.files.insert(row)
        } catch (error: unknown) {
          await staging.delete(stagingKey(ownerSegment, id)).catch(() => undefined)
          throw error
        }
        return row
      })
      stored.catch(abort)
    })
    parser.on('error', () => {
      abort(new UploadRejection('the multipart body is malformed', 400, 'invalid_file'))
    })
    parser.on('close', () => {
      void (async () => {
        let row: FileRow | undefined
        try {
          row = await stored
        } catch {
          // `abort` already settled the request with this failure.
          return
        }
        if (settled) {
          if (row !== undefined) await discard(row)
          return
        }
        if (purpose !== 'user_data') flag('"purpose" must be "user_data"')
        if (row === undefined) flag('the request has no "file" part')
        if (pending !== undefined) {
          if (row !== undefined) await discard(row)
          abort(pending)
          return
        }
        if (await store.files.stagedBytes(owner) > limits.maxStagedBytesPerOwner) {
          await discard(row!)
          abort(quotaRejection())
          return
        }
        settled = true
        resolve(row!)
      })().catch(abort)
    })
    req.on('aborted', () => {
      abort(new UploadRejection('the upload was interrupted', 400, 'invalid_file'))
    })
    req.pipe(parser)
  })
}

/**
 * Wrap the file part: collect the first bytes, decide the media type, then pass every byte on.
 * @param stream - busboy file stream.
 * @param name - sanitized name.
 * @param declaredType - the part's `Content-Type`.
 * @param limits - upload limits.
 * @param decided - receives the server-decided media type once the first bytes are classified.
 * @returns the chunks to store.
 * @throws UploadRejection from classification; FileTooLargeError when busboy truncated the part at the size limit.
 */
async function* sniffed(
  stream: Readable & { truncated?: boolean },
  name: string,
  declaredType: string,
  limits: UploadLimits,
  decided: (mediaType: string) => void,
): AsyncGenerator<Uint8Array> {
  const held: Buffer[] = []
  let heldBytes = 0
  let classified = false
  const classify = (): void => {
    decided(classifyUpload({ head: Buffer.concat(held).subarray(0, SNIFF_BYTES), name, declaredType, allowed: limits.allowedMediaTypes }))
    classified = true
  }
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (classified) {
      yield chunk
      continue
    }
    held.push(chunk)
    heldBytes += chunk.byteLength
    if (heldBytes >= SNIFF_BYTES) {
      classify()
      yield* held
      held.length = 0
    }
  }
  if (!classified) {
    classify()
    yield* held
  }
  if (stream.truncated === true) throw new FileTooLargeError(limits.maxFileBytes)
}
