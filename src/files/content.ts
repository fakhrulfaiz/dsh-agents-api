/**
 * `GET /agents/files/{id}/content`: serve file bytes from any `FileSource`, after the source has checked the owner.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { OwnerId } from '../auth/authenticator.ts'
import { servedType } from './sniff.ts'

/** One file ready to serve. */
export interface ServedFile {
  /** Leaf name for `Content-Disposition`. */
  name: string
  /** Stored media type; `servedType` turns it into the response type. */
  mediaType: string
  /** Exact body length. */
  bytes: number
  /** The body, read lazily and at most once. */
  body: () => AsyncIterable<Uint8Array>
}

/**
 * Where served files come from: staged uploads and attached files today; tool-result images and agent
 * deliverables can be added as further sources behind the same route.
 */
export interface FileSource {
  /**
   * Look a file up for one owner. The source performs the owner check; another owner's id reads as absent.
   * @param owner - authenticated caller.
   * @param id - file id from the route.
   * @returns the file, or `undefined` when this source has no such file for `owner`.
   */
  open(owner: OwnerId, id: string): Promise<ServedFile | undefined>
}

/**
 * ASCII-only `filename` fallback for old clients.
 * @param name - leaf name.
 * @returns the name with non-ASCII, quotes, backslashes, percent signs, and semicolons replaced by `_`.
 */
function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]|["\\%;]/gu, '_')
}

/**
 * Headers every served file carries. `Content-Security-Policy: sandbox` and `nosniff` keep a mislabelled file
 * from running in the API origin; the disposition is inline only for sniffed rasters.
 * @param file - file to serve.
 * @returns response headers.
 */
export function contentHeaders(file: ServedFile): Record<string, string> {
  const { contentType, inline } = servedType(file.mediaType)
  return {
    'Content-Type': contentType,
    'Content-Length': String(file.bytes),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Content-Disposition': inline
      ? 'inline'
      : `attachment; filename="${asciiFallback(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Cache-Control': 'private, max-age=3600',
  }
}

/**
 * Stream `file` as the response. A failure after the headers were sent ends the connection without a clean finish.
 * @param req - request, for abort handling.
 * @param res - response.
 * @param file - file to serve.
 */
export async function serveFile(req: IncomingMessage, res: ServerResponse, file: ServedFile): Promise<void> {
  const source = Readable.from(file.body(), { objectMode: false })
  res.writeHead(200, contentHeaders(file))
  req.on('close', () => {
    if (!res.writableEnded) source.destroy()
  })
  try {
    await pipeline(source, res)
  } catch {
    // The client went away or the source failed mid-body; the status line is already sent, so the connection is dropped.
    res.destroy()
  }
}
