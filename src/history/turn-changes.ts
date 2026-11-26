/**
 * Per-turn changed files: DSH `workspace-changes` summaries (local chats) or
 * the sandbox recorder's (sandbox chats), mapped to Agentry turn ids and the
 * wire shapes of `/agents/sessions/{id}/turns/{turn_id}/changes`.
 *
 * Files outside the workspace (absolute paths) are counted in `outside` but
 * never listed, and their diffs are never served.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One changed file as DSH (and the sandbox recorder) report it. */
export interface ChangedFile {
  /** Workspace-relative, or an absolute path outside the workspace. */
  path: string
  display: string
  added: number
  deleted: number
  binary?: true
  oversized?: true
}

/** A turn's changes as DSH (and the sandbox recorder) report them. */
export interface ChangesSummary {
  turn: number
  files: ChangedFile[]
  total: number
  added: number
  deleted: number
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type FileDiff =
  | { kind: 'text'; path: string; display: string; before: boolean; after: boolean; hunks: DiffHunk[]; coarse: boolean }
  | { kind: 'binary' | 'oversized'; path: string; display: string }

/** The part of DSH's `workspaceChanges` service the routes use (structural, so the DSH package stays optional). */
export interface WorkspaceChangesLike {
  summary(sessionId: string, seq: number): ChangesSummary | undefined
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<FileDiff | undefined>
}

export interface TurnChangesFile {
  /** Index in the recorder's file list; kept when outside files are dropped. */
  index: number
  path: string
  display: string
  added: number
  deleted: number
  binary?: true
  oversized?: true
}

export interface TurnChanges {
  object: 'agent.session.turn.changes'
  turn_id: string
  available: boolean
  /** Changed files inside the workspace (including any beyond the listed cap). */
  total: number
  added: number
  deleted: number
  /** Changed files outside the workspace; counted, never listed. */
  outside: number
  files: TurnChangesFile[]
}

export interface TurnChange {
  object: 'agent.session.turn.change'
  kind: 'text' | 'binary' | 'oversized'
  path: string
  display: string
  before?: boolean
  after?: boolean
  hunks?: { old_start: number; old_lines: number; new_start: number; new_lines: number; lines: string[] }[]
  coarse?: boolean
}

/** Whether a reported path lies outside the workspace. */
export const isOutside = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

/**
 * @param events - the session's log, in order.
 * @returns turn id (`turn_<seq of turn/start>`) to the seq of that turn's latest `workspace/changes` event.
 */
export function changeEventsByTurn(events: readonly SessionEvent[]): Map<string, number> {
  const byNumber = new Map<number, string>()
  const out = new Map<string, number>()
  for (const event of events) {
    const type = event.type as string
    const turn = (event.data as { turn?: unknown } | undefined)?.turn
    if (type === 'turn/start') {
      if (typeof turn === 'number') byNumber.set(turn, `turn_${String(event.seq)}`)
      continue
    }
    if (type !== 'workspace/changes' || typeof turn !== 'number') continue
    const turnId = byNumber.get(turn)
    if (turnId !== undefined) out.set(turnId, event.seq)
  }
  return out
}

/** @returns turn ids of the log's `turn/start` events. */
export function turnIds(events: readonly SessionEvent[]): Set<string> {
  return new Set(events.filter(event => (event.type as string) === 'turn/start').map(event => `turn_${String(event.seq)}`))
}

/**
 * @param turnId - Agentry turn id.
 * @param summary - the recorder's summary, or `undefined` when there is none (never recorded, or lost on restart).
 * @returns the wire summary; outside files are counted, not listed.
 */
export function toWireSummary(turnId: string, summary: ChangesSummary | undefined): TurnChanges {
  if (summary === undefined) {
    return { object: 'agent.session.turn.changes', turn_id: turnId, available: false, total: 0, added: 0, deleted: 0, outside: 0, files: [] }
  }
  const files: TurnChangesFile[] = []
  let outside = 0
  let outsideAdded = 0
  let outsideDeleted = 0
  summary.files.forEach((file, index) => {
    if (isOutside(file.path)) {
      outside += 1
      outsideAdded += file.added
      outsideDeleted += file.deleted
      return
    }
    files.push({
      index, path: file.path, display: file.display, added: file.added, deleted: file.deleted,
      ...(file.binary ? { binary: true as const } : {}),
      ...(file.oversized ? { oversized: true as const } : {}),
    })
  })
  return {
    object: 'agent.session.turn.changes',
    turn_id: turnId,
    available: true,
    total: Math.max(0, summary.total - outside),
    added: Math.max(0, summary.added - outsideAdded),
    deleted: Math.max(0, summary.deleted - outsideDeleted),
    outside,
    files,
  }
}

/** @returns the wire form of one file's comparison. */
export function toWireDiff(diff: FileDiff): TurnChange {
  if (diff.kind !== 'text') return { object: 'agent.session.turn.change', kind: diff.kind, path: diff.path, display: diff.display }
  return {
    object: 'agent.session.turn.change',
    kind: 'text',
    path: diff.path,
    display: diff.display,
    before: diff.before,
    after: diff.after,
    hunks: diff.hunks.map(hunk => ({ old_start: hunk.oldStart, old_lines: hunk.oldLines, new_start: hunk.newStart, new_lines: hunk.newLines, lines: hunk.lines })),
    coarse: diff.coarse,
  }
}
