import { describe, expect, it } from 'vitest'
import { createSessionHistory } from '../../src/history/session-history.ts'
import { FakeSessionQuery, logEvent } from '../support/fake-session-query.ts'

describe('deliverables', () => {
  it('lists presented files with turn and description, deduplicated by path', async () => {
    const query = new FakeSessionQuery()
    const e = (type: string, data: unknown, seq: number) => logEvent(type as never, data as never, seq, 5000)
    for (const event of [
      e('turn/start', { turn: 1 }, 10),
      e('deliverables/presented', { turn: 1, callId: 'c1', files: [{ path: '/w/a.docx', description: 'Report' }, { path: '/w/b.png' }] }, 11),
      e('turn/start', { turn: 2 }, 20),
      e('deliverables/presented', { turn: 2, callId: 'c2', files: [{ path: '/w/a.docx', description: 'Report v2' }] }, 21),
    ]) query.append('s', event)
    expect(await createSessionHistory(query).deliverables('s')).toEqual([
      { path: '/w/a.docx', description: 'Report v2', turn_id: 'turn_20', created_at: 5 },
      { path: '/w/b.png', turn_id: 'turn_10', created_at: 5 },
    ])
    expect(await createSessionHistory(new FakeSessionQuery()).deliverables('none')).toEqual([])
  })
})
