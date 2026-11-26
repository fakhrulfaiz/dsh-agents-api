import { describe, expect, it } from 'vitest'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { materializeAgent } from '../../src/agent-records.ts'
import { WireProjector, frameSseId, type ProjectionBase } from '../../src/history/projector.ts'
import { createSessionHistory } from '../../src/history/session-history.ts'
import { SessionRegistry, subagentResource } from '../../src/session-registry.ts'
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

describe('SessionHistory subagents', () => {
  /** Two events inherited from the parent (a fork seed), then the child's own work. */
  const INHERITED = [
    logEvent('turn/start', { turn: 1 }, 0, 1_000),
    logEvent('turn/end', { reason: { kind: 'completed' } }, 1, 1_000),
  ]
  const OWN = [
    logEvent('request/header', { header: { config: { provider: 'p', model: 'deepseek-flash' } }, reason: 'resume' }, 2, 6_000),
    logEvent('turn/start', { turn: 2 }, 3, 6_000),
    logEvent('user/message', { content: [{ type: 'text', text: 'find files' }], source: { kind: 'user' } }, 4, 6_000),
    logEvent('step/start', { turn: 2, step: 1 }, 5, 6_100),
    logEvent('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'glob', arguments: '{}' }, 6, 6_200),
    logEvent('tool/result', { turn: 2, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a.ts' }] }] } }, 7, 7_000),
    logEvent('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'found a.ts' }] } }, 8, 7_500),
    logEvent('turn/end', { reason: { kind: 'completed' }, usage: { inputTokens: 3, outputTokens: 4 } }, 9, 8_000),
  ]

  function withChild() {
    const { query, history } = setup()
    query.headers.set('child_1', { parentSession: 'sess_h', origin: 'subagent', createdAt: 5_500, inheritedEventCount: INHERITED.length })
    for (const event of [...INHERITED, ...OWN]) query.append('child_1', event)
    // A child of another session and a non-subagent child stay out of the list.
    query.headers.set('child_other', { parentSession: 'sess_x', origin: 'subagent' })
    query.append('child_other', logEvent('turn/start', { turn: 1 }, 0))
    query.headers.set('fork_1', { parentSession: 'sess_h' })
    query.append('fork_1', logEvent('turn/start', { turn: 1 }, 0))
    return { query, history }
  }

  it('rebuilds a closed child from its log exactly as the live registry projected it', async () => {
    const { query, history } = withChild()
    const registry = new SessionRegistry()
    registry.register(new WireProjector(base, false))
    for (const event of OWN) registry.applyChildEvent('sess_h', 'child_1', event, 5_500)
    registry.closeSubagent('sess_h', 'child_1')
    const live = registry.getSubagent('sess_h', 'child_1')!

    query.crash()
    const [rebuilt, ...rest] = await history.subagents('sess_h', agent.id)
    expect(rest).toEqual([])
    expect(rebuilt!.resource).toEqual(subagentResource(live))
    expect(rebuilt!.resource).toMatchObject({ status: 'closed', created_at: 5, closed_at: 8, model: 'deepseek-flash' })
    expect(rebuilt!.turns).toEqual(live.turns)
    expect(rebuilt!.turns).toMatchObject([{ id: 'turn_3', session_id: 'child_1', subagent_id: 'child_1', status: 'completed' }])
    expect(rebuilt!.items).toEqual(live.items)
    expect(rebuilt!.items.map(item => item.id)).toEqual(['item_msg_4', 'item_fn_6', 'item_fn_out_7', 'item_msg_8'])
    expect(rebuilt!.items.every(item => item.subagent_id === 'child_1')).toBe(true)
  })

  it('shows a child whose log is live as active, and finds one child by id', async () => {
    const { history } = withChild()
    expect(await history.subagentIds('sess_h')).toEqual(['child_1'])
    const [one] = await history.subagents('sess_h', agent.id, 'child_1')
    expect(one!.resource).toMatchObject({ id: 'child_1', status: 'active' })
    expect(one!.resource.closed_at).toBeUndefined()
    expect(await history.subagents('sess_h', agent.id, 'child_other')).toEqual([])
  })

  it('has no subagents without a parent log or lineage tracing', async () => {
    expect(await createSessionHistory(new FakeSessionQuery()).subagents('sess_none', agent.id)).toEqual([])
    const { query } = withChild()
    expect(await createSessionHistory({ readSession: query.readSession }).subagentIds('sess_h')).toEqual([])
  })
})
