/**
 * Skill packages: a validated set of files with a `SKILL.md` at the root,
 * read from a zip, a file list (GitHub), or the web editor. Validation is the
 * same for every source; nothing here touches the filesystem.
 */

import { createHash } from 'node:crypto'
import { strToU8, unzipSync } from 'fflate'
import { parse, stringify } from 'yaml'

/** One file of a package, at a relative POSIX path. */
export interface SkillFile {
  path: string
  bytes: Uint8Array
}

/** A validated skill. */
export interface SkillPackage {
  name: string
  description: string
  files: SkillFile[]
  /** Whether any file is executable content (it runs in the session sandbox). */
  hasScripts: boolean
  /** sha256 over the sorted `path\0bytes` entries. */
  contentHash: string
  /** The `SKILL.md` text. */
  skillMd: string
}

/** A package that breaks a rule; the message names the rule. */
export class SkillInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillInvalidError'
  }
}

/** A package over the size, file-count, or expansion limits. */
export class SkillTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillTooLargeError'
  }
}

export const SKILL_LIMITS = { maxBytes: 5_242_880, maxFiles: 200, nameMax: 64, descriptionMax: 1024, maxRatio: 100 } as const

/** Skill name grammar: lowercase kebab-case. */
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/u

const SCRIPT_EXTENSIONS = /\.(sh|bash|py|js|mjs|cjs|ts|ps1|rb|pl)$/u

/** One central-directory entry. */
interface ZipEntry {
  name: string
  compressedSize: number
  size: number
  isSymlink: boolean
}

/**
 * Read the zip central directory (declared sizes and Unix mode bits), without inflating anything.
 * @param bytes - zip archive.
 * @returns the entries in directory order.
 */
function centralDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new SkillInvalidError('the file is not a zip archive')
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new SkillInvalidError('the zip directory is damaged')
    const madeByOs = view.getUint8(offset + 5)
    const compressedSize = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const external = view.getUint32(offset + 38, true)
    if (compressedSize === 0xffffffff || size === 0xffffffff) throw new SkillTooLargeError('zip64 archives are not supported')
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    const mode = madeByOs === 3 ? external >>> 16 : 0
    entries.push({ name, compressedSize, size, isSymlink: (mode & 0o170000) === 0o120000 })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Entries that are not content: directories and macOS resource forks. */
const ignored = (name: string): boolean => name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').at(-1) === '.DS_Store'

/**
 * @param bytes - a zip archive.
 * @param reserved - built-in skill names an installed skill may not take.
 * @returns the validated package.
 * @throws SkillInvalidError or SkillTooLargeError.
 */
export function readSkillZip(bytes: Uint8Array, reserved: ReadonlySet<string>): SkillPackage {
  const entries = centralDirectory(bytes).filter(e => !ignored(e.name))
  for (const entry of entries) {
    if (entry.isSymlink) throw new SkillInvalidError(`"${entry.name}" is a symlink; skills may not contain symlinks`)
    checkPath(entry.name)
  }
  if (entries.length > SKILL_LIMITS.maxFiles) throw new SkillTooLargeError(`a skill may hold at most ${String(SKILL_LIMITS.maxFiles)} files`)
  let total = 0
  for (const entry of entries) {
    total += entry.size
    if (entry.size > SKILL_LIMITS.maxBytes || total > SKILL_LIMITS.maxBytes) throw new SkillTooLargeError('a skill may be at most 5 MB uncompressed')
    if (entry.size > 4096 && entry.size > SKILL_LIMITS.maxRatio * Math.max(entry.compressedSize, 1)) {
      throw new SkillTooLargeError(`"${entry.name}" expands more than ${String(SKILL_LIMITS.maxRatio)} times; the archive looks like a zip bomb`)
    }
  }
  const wanted = new Set(entries.map(e => e.name))
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: (file) => wanted.has(file.name) })
  } catch {
    throw new SkillInvalidError('the zip archive could not be read')
  }
  const list = Object.entries(files).map(([path, data]) => ({ path, bytes: data }))
  for (const file of list) {
    if (file.bytes.length !== entries.find(e => e.name === file.path)?.size) throw new SkillInvalidError(`"${file.path}" does not match its declared size`)
  }
  const { files: stripped, folder } = stripTopFolder(list)
  return packageFromFiles(stripped, reserved, folder)
}

/**
 * Drop one top-level folder shared by every file (GitHub and most zip tools add one).
 * @param files - files at archive paths.
 * @returns the files relative to that folder, and its name when there was one.
 */
function stripTopFolder(files: SkillFile[]): { files: SkillFile[]; folder?: string } {
  if (files.some(f => f.path === 'SKILL.md')) return { files }
  const tops = new Set(files.map(f => f.path.split('/')[0]))
  const [top] = tops
  if (tops.size !== 1 || top === undefined || files.some(f => !f.path.startsWith(`${top}/`))) return { files }
  return { files: files.map(f => ({ path: f.path.slice(top.length + 1), bytes: f.bytes })), folder: top }
}

/**
 * @param path - archive path.
 * @throws SkillInvalidError for an absolute, parent, empty-segment, backslash or hidden path.
 */
function checkPath(path: string): void {
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\\') || path.includes('\0')) throw new SkillInvalidError(`"${path}": only relative paths are allowed`)
  const segments = path.split('/')
  if (segments.some(s => s === '..' || s === '.' || s === '')) throw new SkillInvalidError(`"${path}": path segments may not be empty, "." or ".."`)
  if (segments.some(s => s.startsWith('.') && s !== '.gitkeep')) throw new SkillInvalidError(`"${path}": hidden files and folders are not allowed`)
}

/**
 * Validate a file list into a package.
 * @param files - files at paths relative to the skill folder.
 * @param reserved - built-in skill names.
 * @param expectedName - folder name the frontmatter name must equal, when known.
 * @returns the validated package.
 */
export function packageFromFiles(files: SkillFile[], reserved: ReadonlySet<string>, expectedName?: string): SkillPackage {
  for (const file of files) checkPath(file.path)
  if (files.length > SKILL_LIMITS.maxFiles) throw new SkillTooLargeError(`a skill may hold at most ${String(SKILL_LIMITS.maxFiles)} files`)
  const total = files.reduce((sum, f) => sum + f.bytes.length, 0)
  if (total > SKILL_LIMITS.maxBytes) throw new SkillTooLargeError('a skill may be at most 5 MB uncompressed')
  const skill = files.find(f => f.path === 'SKILL.md')
  if (skill === undefined) throw new SkillInvalidError('SKILL.md not found at the root of the skill')
  const skillMd = new TextDecoder().decode(skill.bytes)
  const { name, description } = frontmatter(skillMd)
  checkName(name, reserved)
  if (expectedName !== undefined && expectedName !== name) throw new SkillInvalidError(`the frontmatter name "${name}" must equal the folder name "${expectedName}"`)
  if (description.length === 0) throw new SkillInvalidError('SKILL.md frontmatter needs a description')
  if (description.length > SKILL_LIMITS.descriptionMax) throw new SkillInvalidError(`the description may be at most ${String(SKILL_LIMITS.descriptionMax)} characters`)
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = createHash('sha256')
  for (const file of sorted) hash.update(file.path).update('\0').update(file.bytes).update('\0')
  return {
    name,
    description,
    files: sorted,
    hasScripts: sorted.some(f => f.path.startsWith('scripts/') || SCRIPT_EXTENSIONS.test(f.path)),
    contentHash: hash.digest('hex'),
    skillMd,
  }
}

/**
 * @param name - proposed skill name.
 * @param reserved - built-in names.
 * @throws SkillInvalidError when the name breaks the grammar or is reserved.
 */
export function checkName(name: string, reserved: ReadonlySet<string>): void {
  if (name.length === 0 || name.length > SKILL_LIMITS.nameMax || !SKILL_NAME.test(name)) {
    throw new SkillInvalidError(`the skill name "${name}" must be lowercase letters, digits and single hyphens, at most ${String(SKILL_LIMITS.nameMax)} characters`)
  }
  if (reserved.has(name)) throw new SkillInvalidError(`the skill name "${name}" is reserved for a built-in skill`)
}

/**
 * @param text - `SKILL.md` text.
 * @returns the frontmatter name and description.
 */
function frontmatter(text: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (match === null) throw new SkillInvalidError('SKILL.md must start with YAML frontmatter (--- name, description ---)')
  let data: unknown
  try {
    data = parse(match[1] ?? '')
  } catch {
    throw new SkillInvalidError('SKILL.md frontmatter is not valid YAML')
  }
  const record = (data ?? {}) as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  return { name, description }
}

/**
 * Build a one-file package from the web editor or the `skill_create` tool.
 * @param input - name, description, and Markdown body.
 * @param reserved - built-in names.
 * @returns the validated package.
 */
export function packageFromEditor(input: { name: string; description: string; body: string }, reserved: ReadonlySet<string>): SkillPackage {
  const head = stringify({ name: input.name.trim(), description: input.description.trim() }).trimEnd()
  const text = `---\n${head}\n---\n\n${input.body.trim()}\n`
  return packageFromFiles([{ path: 'SKILL.md', bytes: strToU8(text) }], reserved)
}

/**
 * @param text - `SKILL.md` text.
 * @returns the Markdown body after the frontmatter.
 */
export function skillBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').replace(/^\s+/u, '')
}
