/** Parsers for git output read from a sandbox: `diff-tree -z --numstat` and a one-file unified diff. */
import type { DiffHunk } from './turn-changes.ts'

export interface NumstatEntry {
  path: string
  added: number
  deleted: number
  binary?: true
}

/**
 * @param out - `git diff-tree -r -z --numstat --no-renames` output (`added\tdeleted\tpath\0` records).
 * @returns entries in output order; binary files (`-\t-`) carry `binary` and zero counts.
 */
export function parseNumstat(out: string): NumstatEntry[] {
  const entries: NumstatEntry[] = []
  for (const record of out.split('\0')) {
    const line = record.replace(/^\n+/, '')
    if (line === '') continue
    const first = line.indexOf('\t')
    const second = line.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const a = line.slice(0, first)
    const d = line.slice(first + 1, second)
    const path = line.slice(second + 1)
    if (path === '') continue
    if (a === '-' && d === '-') entries.push({ path, added: 0, deleted: 0, binary: true })
    else entries.push({ path, added: Number(a) || 0, deleted: Number(d) || 0 })
  }
  return entries
}

export interface ParsedDiff {
  binary: boolean
  before: boolean
  after: boolean
  hunks: DiffHunk[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * @param text - `git diff --no-color -U3 <a> <b> -- <path>` output for one file.
 * @returns hunks with prefixed lines; `\ No newline at end of file` markers are dropped.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const result: ParsedDiff = { binary: false, before: true, after: true, hunks: [] }
  let hunk: DiffHunk | undefined
  for (const line of text.split('\n')) {
    const header = HUNK.exec(line)
    if (header) {
      hunk = {
        oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      result.hunks.push(hunk)
      continue
    }
    if (hunk === undefined) {
      if (line.startsWith('new file mode')) result.before = false
      else if (line.startsWith('deleted file mode')) result.after = false
      else if (line.startsWith('Binary files ') && line.endsWith(' differ')) result.binary = true
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) hunk.lines.push(line)
    else if (line.startsWith('diff --git')) hunk = undefined
  }
  return result
}
