/**
 * Office previews: which files convert, the input cap, and how DSH's
 * `officeToPdf` failure codes become HTTP answers. Messages are plain and
 * never carry engine diagnostics.
 */

/** Office formats DSH's `officeToPdf` converts. */
export type OfficeExtension = 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'

const OFFICE = new Set<string>(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])

/** DSH's default input cap; larger files answer 413 without being read. */
export const MAX_OFFICE_INPUT_BYTES = 50 * 1024 * 1024

/**
 * @param path - workspace-relative path.
 * @returns the lower-case Office extension, or `undefined` for any other file.
 */
export function officeExtension(path: string): OfficeExtension | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = name.slice(dot + 1).toLowerCase()
  return OFFICE.has(ext) ? ext as OfficeExtension : undefined
}

/**
 * @param code - an `OfficeToPdfError` code.
 * @returns the HTTP status, wire code and a plain message.
 */
export function renderError(code: string): { status: number; code: string; message: string } {
  switch (code) {
    case 'input-too-large':
    case 'output-too-large':
      return { status: 413, code: 'file_too_large', message: 'The file is too large to preview.' }
    case 'invalid-document':
    case 'unsupported-format':
      return { status: 422, code: 'invalid_document', message: 'The file could not be read as a document.' }
    case 'timeout':
      return { status: 504, code: 'render_timeout', message: 'The preview took too long.' }
    case 'busy':
      return { status: 503, code: 'render_busy', message: 'The preview service is busy. Try again.' }
    case 'unavailable':
      return { status: 503, code: 'render_unavailable', message: 'Document preview is not available.' }
    case 'source-changed':
      return { status: 409, code: 'source_changed', message: 'The file changed while it was converted. Try again.' }
    default:
      return { status: 500, code: 'render_failed', message: 'The document could not be converted.' }
  }
}

/**
 * @param names - font families the conversion did not have.
 * @returns the `x-agentry-missing-fonts` value, or `undefined` when none are missing.
 */
export function missingFontsHeader(names: readonly string[]): string | undefined {
  return names.length === 0 ? undefined : names.map(encodeURIComponent).join(',')
}
