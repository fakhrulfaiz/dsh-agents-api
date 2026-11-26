/** Mapping DSH workspace-changes summaries to Agentry turns and wire shapes. */
import { describe, expect, it } from 'vitest'
import { changeEventsByTurn, toWireDiff, toWireSummary } from '../../src/history/turn-changes.ts'
import { logEvent } from '../support/fake-session-query.ts'

describe('changeEventsByTurn', () => {
  it('maps DSH turn numbers to turn ids; the later event for a turn wins; unknown turns are ignored', () => {
    const map = changeEventsByTurn([
      logEvent('turn/start', { turn: 1 }, 1),
      logEvent('workspace/changes', { turn: 1 }, 5),
      logEvent('turn/end', { turn: 1 }, 6),
      logEvent('workspace/changes', { turn: 1 }, 7),
      logEvent('turn/start', { turn: 2 }, 8),
      logEvent('workspace/changes', { turn: 2 }, 9),
      logEvent('workspace/changes', { turn: 9 }, 10),
    ])
    expect([...map]).toEqual([['turn_1', 7], ['turn_8', 9]])
  })
})

describe('toWireSummary', () => {
  it('counts outside files without listing them and keeps the original index', () => {
    const wire = toWireSummary('turn_1', {
      turn: 1,
      total: 3,
      added: 10,
      deleted: 4,
      files: [
        { path: '/home/u/.bashrc', display: '~/.bashrc', added: 1, deleted: 1 },
        { path: 'src/a.ts', display: 'src/a.ts', added: 8, deleted: 3 },
        { path: 'img.png', display: 'img.png', added: 0, deleted: 0, binary: true },
      ],
    })
    expect(wire).toEqual({
      object: 'agent.session.turn.changes', turn_id: 'turn_1', available: true, total: 2, added: 9, deleted: 3, outside: 1,
      files: [
        { index: 1, path: 'src/a.ts', display: 'src/a.ts', added: 8, deleted: 3 },
        { index: 2, path: 'img.png', display: 'img.png', added: 0, deleted: 0, binary: true },
      ],
    })
  })

  it('is unavailable without a summary', () => {
    expect(toWireSummary('turn_4', undefined)).toMatchObject({ available: false, total: 0, files: [] })
  })
})

describe('toWireDiff', () => {
  it('renames hunk fields', () => {
    expect(toWireDiff({ kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' x', '+y'] }] }))
      .toEqual({ object: 'agent.session.turn.change', kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false, hunks: [{ old_start: 1, old_lines: 2, new_start: 1, new_lines: 3, lines: [' x', '+y'] }] })
    expect(toWireDiff({ kind: 'binary', path: 'b', display: 'b' })).toEqual({ object: 'agent.session.turn.change', kind: 'binary', path: 'b', display: 'b' })
  })
})
