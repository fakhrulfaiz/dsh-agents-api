/**
 * Upload file names. A name is only ever a leaf: it never selects a directory, on disk or in the workspace.
 */

/** Longest stored name in UTF-8 bytes. */
const MAX_NAME_BYTES = 120

/** Device names Windows refuses as a file's base name. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** Control characters, bidi overrides, and characters Windows file systems reject. */
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩<>:"|?*]/gu

/**
 * Cut `text` to at most `max` UTF-8 bytes without splitting a code point.
 * @param text - text to shorten.
 * @param max - byte limit.
 * @returns the longest prefix within the limit.
 */
function truncateBytes(text: string, max: number): string {
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (used + size > max) break
    out += char
    used += size
  }
  return out
}

/**
 * Reduce a client-supplied file name to a safe leaf name: last path segment (both separators), NFC, no control
 * or reserved characters, no leading dots, no trailing dots or spaces, a Windows device base name prefixed with
 * `_`, at most 120 bytes with the extension kept.
 * @param raw - name from the multipart header.
 * @returns the leaf name, or `undefined` when nothing usable remains (empty, `.`, `..`, only dots).
 */
export function sanitizeFileName(raw: string): string | undefined {
  const leaf = raw.normalize('NFC').split(/[\\/]/u).at(-1) ?? ''
  const cleaned = leaf.replace(FORBIDDEN, '_').replace(/^\.+/u, '').replace(/[. ]+$/u, '').trim()
  if (cleaned === '' || /^_*$/u.test(cleaned)) return undefined
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const extension = dot > 0 ? cleaned.slice(dot) : ''
  const safeStem = WINDOWS_RESERVED.test(stem) ? `_${stem}` : stem
  const keep = extension !== '' && Buffer.byteLength(extension) < MAX_NAME_BYTES ? extension : ''
  const name = truncateBytes(safeStem, MAX_NAME_BYTES - Buffer.byteLength(keep)).replace(/[. ]+$/u, '') + keep
  return name === '' || name === keep ? undefined : name
}

/**
 * Name for an extra copy of `name` in a directory where it already exists.
 * @param name - sanitized leaf name.
 * @param attempt - 1 for `name-1.ext`, 2 for `name-2.ext`, and so on.
 * @returns the numbered leaf name, still within the byte limit.
 */
export function numberedName(name: string, attempt: number): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const suffix = `-${String(attempt)}${extension}`
  return truncateBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(suffix)) + suffix
}
