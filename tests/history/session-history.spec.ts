import { describe, expect, it } from 'vitest'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { materializeAgent } from '../../src/agent-records.ts'
import { WireProjector, frameSseId, type ProjectionBase } from '../../src/history/projector.ts'
import { createSessionHistory } from '../../src/history/session-history.ts'
import { SessionRegistry } from '../../src/session-registry.ts'
import { FakeSessionQuery, logEvent } from '../support/fake-session-query.ts'

const agent = materializeAgent({ model: 'deepseek-chat' })
const base: ProjectionBase = { sessionId: 'sess_h', createdAt: 100, agent, environment: { type: 'none' }, metadata: {}, vaultIds: [] }

/** Three turns whose events share the same second. */
const SAME_SECOND = [1, 2, 3].flatMap((turn) => {
  const first = turn * 10
  return [
    logEvent('turn/start', { turn }, first, 5000),
    logEvent('user/message', { content: [{ type: 'text', text: `q${String(turn)}` }], source: { kind: 'user' } }, first + 1, 5000),
    logEvent('assistant/message', { message: { content: [{ type: 'text', text: `a${String(turn)}` }] } }, first + 2, 5000),
    logEvent('turn/end', { reason: { kind: 'completed' } }, first + 3, 5000),
  ]
})

function setup(events = SAME_SECOND) {
  const query = new FakeSessionQuery()
  for (const event of events) query.append('sess_h', event)
  return { query, history: createSessionHistory(query) }
}

describe('SessionHistory', () => {
  it('items match the live projection of the same events', async () => {
    const { history } = setup()
    const registry = new SessionRegistry()
    registry.register(new WireProjector(base, false))
    for (const event of SAME_SECOND) registry.apply('sess_h', event)

    const fromLog = await history.items(base, { limit: 100 })
    expect(fromLog.data).toEqual(registry.get('sess_h')!.projector.items)
    expect(fromLog.data.map(item => item.id)).toEqual(['item_msg_11', 'item_msg_12', 'item_msg_21', 'item_msg_22', 'item_msg_31', 'item_msg_32'])
    expect(await history.turns(base, { limit: 100, order: 'asc' })).toMatchObject({ data: registry.get('sess_h')!.projector.turns })
  })

  it('wire events are the projector frames after the given id or position', async () => {
    const { history } = setup()
    const all = await history.wireEvents(base, 0)
    expect(all[0]?.event.type).toBe('agent.session.created')
    const original = all.filter(frame => frame.sub === undefined)
    expect(original.map(frame => frame.id)).toEqual(original.map((_, index) => index + 1))
    const live = new WireProjector(base, false)
    const liveIds = SAME_SECOND.flatMap(event => live.apply(event).frames.map(frameSseId))
    expect(all.slice(1).map(frameSseId)).toEqual(liveIds)
    const last = original.length
    expect((await history.wireEvents(base, last - 2)).map(frameSseId)).toEqual(all.filter(frame => frame.id > last - 2 || (frame.id === last - 2 && frame.sub !== undefined)).map(frameSseId))
    expect(await history.wireEvents(base, last)).toEqual(all.filter(frame => frame.id === last && frame.sub !== undefined))
    // Resuming in the middle of a frame's item frames returns the rest of them.
    const item = all.find(frame => frame.sub !== undefined)
    expect(item).toBeDefined()
    const after = await history.wireEvents(base, { id: item!.id, sub: item!.sub! })
    expect(after[0]).toEqual(all[all.indexOf(item!) + 1])
    expect(after).toHaveLength(all.length - all.indexOf(item!) - 1)
  })

  it('lists turns in log order when they share a second', async () => {
    const { history } = setup()
    expect((await history.turns(base, { limit: 100 })).data.map(turn => turn.id)).toEqual(['turn_30', 'turn_20', 'turn_10'])
    expect((await history.turns(base, { limit: 100, order: 'asc' })).data.map(turn => turn.id)).toEqual(['turn_10', 'turn_20', 'turn_30'])
    expect((await history.turn(base, 'turn_20'))?.status).toBe('completed')
    expect(await history.turn(base, 'turn_nope')).toBeUndefined()
  })

  it('pages items with after, limit, and has_more', async () => {
    const { history } = setup()
    const first = await history.items(base, { limit: 4 })
    expect(first).toMatchObject({ first_id: 'item_msg_11', last_id: 'item_msg_22', has_more: true })
    const second = await history.items(base, { limit: 4, after: first.last_id! })
    expect(second.data.map(item => item.id)).toEqual(['item_msg_31', 'item_msg_32'])
    expect(second.has_more).toBe(false)
    expect((await history.items(base, { limit: 2, order: 'desc' })).data.map(item => item.id)).toEqual(['item_msg_32', 'item_msg_31'])
  })

  it('reads a session that is not live and closes its open turn as interrupted', async () => {
    const { query, history } = setup([
      logEvent('turn/start', { turn: 1 }, 1),
      logEvent('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, 2),
    ])
    query.crash()
    const turns = await history.turns(base, { limit: 10 })
    expect(turns.data[0]).toMatchObject({ id: 'turn_1', status: 'cancelled', error: { code: 'interrupted' } })
    expect((await history.fold(base)).status).toBe('idle')
  })

  it('treats a session without a readable log as empty', async () => {
    const history = createSessionHistory(new FakeSessionQuery())
    expect((await history.items(base, { limit: 10 })).data).toEqual([])
    expect((await history.wireEvents(base, 0)).map(frame => frame.event.type)).toEqual(['agent.session.created'])
    expect(await history.workspace('sess_none')).toBeUndefined()
  })

  it('takes the workspace from the session header', async () => {
    const { query, history } = setup()
    query.cwd = '/work/here'
    expect(await history.workspace('sess_h')).toBe('/work/here')
  })

  it('propagates other read failures', async () => {
    const history = createSessionHistory({
      readSession: () => Promise.reject(new SessionQueryError('corrupt log', 'SESSION_QUERY_SOURCE_CONFLICT')),
    })
    await expect(history.items(base, { limit: 10 })).rejects.toThrow('corrupt log')
    await expect(history.workspace('sess_h')).rejects.toThrow('corrupt log')
  })
})
