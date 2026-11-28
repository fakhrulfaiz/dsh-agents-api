/**
 * A folder inside an environment's workspace, named by a Project so its chats start there.
 */

const MAX_CHARS = 200
const MAX_SEGMENTS = 8

/**
 * Normalize a workspace-relative folder.
 * @param input - raw value from a request body.
 * @returns the cleaned relative path, `undefined` for the workspace root, or `{ error }` naming the broken rule.
 */
export function normalizeWorkspaceSubdir(input: unknown): string | undefined | { error: string } {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'string') return { error: 'Field "directory" must be a string' }
  let value = input.trim()
  if (/[\u0000-\u001f\u007f]/.test(value)) return { error: 'Field "directory" must not contain control characters' }
  if (value.includes('\\')) return { error: 'Field "directory" must not contain backslashes' }
  if (value.startsWith('/') && value.replaceAll('/', '') !== '') return { error: 'Field "directory" must be relative to the workspace, not absolute' }
  value = value.replace(/\/{2,}/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  value = value.replace(/\/+$/, '')
  if (value === '' || value === '.' || value === '/') return undefined
  if (value.length > MAX_CHARS) return { error: `Field "directory" must be at most ${String(MAX_CHARS)} characters` }
  const segments = value.split('/')
  if (segments.includes('..')) return { error: 'Field "directory" must not contain ".." segments' }
  if (segments.length > MAX_SEGMENTS) return { error: `Field "directory" must have at most ${String(MAX_SEGMENTS)} segments` }
  return value
}

/** Single-quote `text` for `/bin/sh`. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}
