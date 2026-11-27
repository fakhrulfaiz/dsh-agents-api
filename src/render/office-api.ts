/**
 * `GET /agents/sessions/:session_id/renders/pdf/*path`: an Office file in the
 * session's workspace (local folder, sandbox or artifact store), converted to
 * PDF by DSH's `officeToPdf` service in this process. The service is optional
 * and read at call time; DSH caches PDFs by content, so there is no cache here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sanitizeRelativePath } from '../artifacts.ts'
import type { OwnerId } from '../auth/authenticator.ts'
import { json } from '../http.ts'
import { MAX_OFFICE_INPUT_BYTES, missingFontsHeader, officeExtension, renderError, type OfficeExtension } from './office.ts'

/** The part of DSH's `OfficeToPdf` this route uses (structural, so the DSH package stays optional). */
export interface OfficeToPdfLike {
  convert(request: {
    extension: OfficeExtension
    priority: 'foreground' | 'background'
    source: {
      key: string
      version: string
      bytes?: number
      read(signal: AbortSignal, maxBytes: number): Promise<{ bytes: Uint8Array; version: string }>
    }
  }, signal?: AbortSignal): Promise<{ pdf: Uint8Array; missingFonts: string[] }>
}

/** One workspace file as the route sees it: its size and version first, its bytes only when asked. */
export interface SessionFile {
  size: number
  /** Changes whenever the content may have changed (`<size>:<mtime>`). */
  version: string
  read(): Promise<Uint8Array>
}

/** A sandbox (or other workspace backend) could not be reached; answered as 503 `sandbox_unavailable`. */
export class WorkspaceUnavailableError extends Error {
  override name = 'WorkspaceUnavailableError'
}

export interface OfficeRenderDeps {
  officeToPdf: () => OfficeToPdfLike | undefined
  /** The session row for this owner, or `undefined` after a 404 was written. */
  requireSession(res: ServerResponse, owner: OwnerId, sessionId: string): Promise<unknown>
  /** The file at a sanitized workspace-relative path, or `undefined` when there is none. Throws `WorkspaceUnavailableError`. */
  sessionFile(owner: OwnerId, sessionId: string, path: string): Promise<SessionFile | undefined>
}

const fail = (res: ServerResponse, status: number, code: string, message: string): void => {
  json(res, status, { error: { type: status >= 500 ? 'server_error' : 'invalid_request_error', code, message } })
}

/**
 * Answer one render request.
 * @param deps - service, owner check and file access.
 * @param req - incoming request (its close aborts the conversion; `if-none-match` may answer 304).
 * @param res - outgoing response.
 * @param owner - calling principal.
 * @param sessionId - session id from the route.
 * @param rawPath - workspace-relative path from the route.
 */
export async function renderOfficePdf(
  deps: OfficeRenderDeps, req: IncomingMessage, res: ServerResponse, owner: OwnerId, sessionId: string, rawPath: string,
): Promise<void> {
  if (await deps.requireSession(res, owner, sessionId) === undefined) return
  const path = sanitizeRelativePath(rawPath)
  if (path === undefined) {
    fail(res, 400, 'invalid_path', 'The path escapes the session workspace.')
    return
  }
  const extension = officeExtension(path)
  if (extension === undefined) {
    fail(res, 400, 'unsupported_format', 'Only doc, docx, xls, xlsx, ppt and pptx files render to PDF.')
    return
  }
  const service = deps.officeToPdf()
  if (service === undefined) {
    const { status, code, message } = renderError('unavailable')
    fail(res, status, code, message)
    return
  }
  let file: SessionFile | undefined
  try {
    file = await deps.sessionFile(owner, sessionId, path)
  } catch (error: unknown) {
    if (error instanceof WorkspaceUnavailableError) {
      fail(res, 503, 'sandbox_unavailable', 'The sandbox could not be reached.')
      return
    }
    throw error
  }
  if (file === undefined) {
    fail(res, 404, 'not_found', 'File not found.')
    return
  }
  if (file.size > MAX_OFFICE_INPUT_BYTES) {
    fail(res, 413, 'file_too_large', 'The file is too large to preview.')
    return
  }
  const etag = `"${file.version}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    res.end()
    return
  }
  const aborted = new AbortController()
  const onClose = (): void => { if (!res.writableEnded) aborted.abort() }
  res.on('close', onClose)
  const source = file
  try {
    const result = await service.convert({
      extension,
      priority: 'foreground',
      source: {
        key: JSON.stringify([owner, sessionId, path]),
        version: source.version,
        bytes: source.size,
        read: async () => ({ bytes: await source.read(), version: source.version }),
      },
    }, aborted.signal)
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/pdf',
      'Content-Length': result.pdf.byteLength,
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    }
    const fonts = missingFontsHeader(result.missingFonts)
    if (fonts !== undefined) headers['X-Agentry-Missing-Fonts'] = fonts
    res.writeHead(200, headers)
    res.end(Buffer.from(result.pdf.buffer, result.pdf.byteOffset, result.pdf.byteLength))
  } catch (error: unknown) {
    if (aborted.signal.aborted) return
    if (error instanceof WorkspaceUnavailableError) {
      fail(res, 503, 'sandbox_unavailable', 'The sandbox could not be reached.')
      return
    }
    const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'failed'
    const mapped = renderError(code)
    if (mapped.code === 'render_busy') res.setHeader('Retry-After', '5')
    fail(res, mapped.status, mapped.code, mapped.message)
  } finally {
    res.off('close', onClose)
  }
}
