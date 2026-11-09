/**
 * Media type decisions for uploads. The server decides: magic bytes identify rasters, an extension allow-list
 * identifies everything else, and the client's `Content-Type` is advisory. A declared or extension-implied
 * raster type that the bytes do not confirm is refused.
 */

/** Raster formats DSH's image store accepts. */
export const RASTER_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Bytes of the file start that `classifyUpload` needs. */
export const SNIFF_BYTES = 8192

const OFFICE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Plain-text source and config extensions, all served as `text/plain`. */
const PLAIN_TEXT = [
  'txt', 'text', 'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'rb', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'toml', 'ini', 'cfg', 'conf', 'env', 'yaml', 'yml', 'css', 'scss', 'lock',
]

/** Lowercase extension (no dot) to the media type it implies. */
const EXTENSION_TYPES: ReadonlyMap<string, string> = new Map<string, string>([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
  ['md', 'text/markdown'], ['markdown', 'text/markdown'],
  ['csv', 'text/csv'], ['tsv', 'text/tab-separated-values'],
  ['json', 'application/json'],
  ['xml', 'application/xml'], ['html', 'text/html'], ['htm', 'text/html'], ['svg', 'image/svg+xml'],
  ['zip', 'application/zip'],
  ...Object.entries(OFFICE),
  ...PLAIN_TEXT.map(extension => [extension, 'text/plain'] as [string, string]),
])

/** Types whose bytes are a ZIP container. */
const ZIP_TYPES = new Set(['application/zip', ...Object.values(OFFICE)])

/** Media types a browser could execute or render actively; they are only ever served as `application/octet-stream`. */
const ACTIVE_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'text/javascript'])

/** A refused upload: the HTTP status and wire code it maps to. */
export class UploadRejection extends Error {
  /**
   * @param message - human-readable reason.
   * @param status - HTTP status.
   * @param code - wire error code.
   */
  constructor(message: string, readonly status: 400 | 413 | 415 | 429, readonly code: string) {
    super(message)
    this.name = 'UploadRejection'
  }
}

/**
 * Identify a raster by its magic bytes.
 * @param head - first bytes of the file (at least 12).
 * @returns the raster media type, or `undefined` when the bytes are not PNG, JPEG, GIF, or WebP.
 */
export function sniffRaster(head: Uint8Array): string | undefined {
  const at = (offset: number, ...bytes: number[]): boolean => bytes.every((byte, index) => head[offset + index] === byte)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return undefined
}

/**
 * @param name - sanitized file name.
 * @returns the media type its extension implies, or `undefined` for none or an unknown extension.
 */
export function typeFromExtension(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? undefined : EXTENSION_TYPES.get(name.slice(dot + 1).toLowerCase())
}

/**
 * @param mediaType - stored media type.
 * @returns whether it is a raster DSH can show to a vision model.
 */
export function isRaster(mediaType: string): boolean {
  return RASTER_TYPES.includes(mediaType)
}

/**
 * Media type and disposition a stored file is served with. Rasters are inline; active types become
 * `application/octet-stream`; everything else keeps its type as a download.
 * @param mediaType - stored media type.
 * @returns the `Content-Type` and whether the file may be shown inline.
 */
export function servedType(mediaType: string): { contentType: string; inline: boolean } {
  if (isRaster(mediaType)) return { contentType: mediaType, inline: true }
  return { contentType: ACTIVE_TYPES.has(mediaType) ? 'application/octet-stream' : mediaType, inline: false }
}

/**
 * Decide the media type of an upload from its first bytes, name, and declared type.
 * @param input - `head` (the first `SNIFF_BYTES` bytes, or fewer for a short file), sanitized `name`, the client's `declaredType`, and `allowed` media types.
 * @returns the server-decided media type.
 * @throws UploadRejection 400 `invalid_file` for an empty file; 415 `unsupported_media_type` when the type is not allowed, the bytes contradict the name or declared raster type, or the content is not what its extension claims.
 */
export function classifyUpload(input: { head: Uint8Array; name: string; declaredType: string | undefined; allowed: readonly string[] }): string {
  const { head, name, allowed } = input
  const declared = input.declaredType?.split(';')[0]?.trim().toLowerCase()
  const advisory = declared === undefined || declared === '' || declared === 'application/octet-stream' ? undefined : declared
  if (head.byteLength === 0) throw new UploadRejection('the file is empty', 400, 'invalid_file')
  const byExtension = typeFromExtension(name)
  const raster = sniffRaster(head)
  const refuse = (message: string): never => {
    throw new UploadRejection(message, 415, 'unsupported_media_type')
  }
  if (raster !== undefined) {
    if (advisory !== undefined && advisory !== raster && !(advisory === 'image/jpg' && raster === 'image/jpeg')) refuse(`the content is ${raster}, not ${advisory}`)
    if (byExtension !== undefined && byExtension !== raster) refuse(`the content is ${raster}, which does not match the extension of "${name}"`)
    if (!allowed.includes(raster)) refuse(`${raster} is not accepted`)
    return raster
  }
  if (byExtension === undefined) return refuse(`the type of "${name}" is not accepted`)
  if (isRaster(byExtension) || (advisory !== undefined && isRaster(advisory))) refuse(`"${name}" is not a valid image`)
  if (!allowed.includes(byExtension)) refuse(`${byExtension} is not accepted`)
  if (byExtension === 'application/pdf') {
    if (new TextDecoder('latin1').decode(head.subarray(0, 5)) !== '%PDF-') refuse(`"${name}" is not a PDF`)
  } else if (ZIP_TYPES.has(byExtension)) {
    if (!(head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05))) refuse(`"${name}" is not a ZIP-based file`)
  } else if (head.includes(0)) {
    refuse(`"${name}" is binary but its type is text`)
  }
  return byExtension
}
