import { describe, expect, it } from 'vitest'
import { materializeAgent } from '../src/agent-store.ts'
import { SessionRegistry } from '../src/session-registry.ts'

describe('SessionRegistry', () => {
  it('tracks session lifecycle, turns, items, and SSE fan-out', () => {
    const registry = new SessionRegistry()
    const agent = materializeAgent({ model: 'deepseek-chat' })
    const state = registry.register('sess_1', agent, { type: 'none' }, { k: 'v' })
    expect(state.status).toBe('idle')
    expect(registry.getOAISession('sess_1')?.metadata).toEqual({ k: 'v' })
    expect(registry.getOAISession('missing')).toBeUndefined()

    const updated = registry.updateSession('sess_1', {
      agent: { model: 'deepseek-v4-flash', reasoning: { effort: 'low' }, service_tier: 'flex' },
      metadata: { n: '1' },
    })
    expect(updated?.agent.model).toBe('deepseek-v4-flash')
    expect(updated?.metadata).toEqual({ n: '1' })
    expect(registry.updateSession('sess_1', { metadata: null })?.metadata).toEqual({})
    expect(registry.updateSession('sess_1', { agent: { service_tier: null } })?.agent.service_tier).toBeNull()
    expect(registry.updateSession('sess_1', { agent: { reasoning: {} } })?.agent.reasoning).toEqual({ effort: 'low' })
    expect(registry.updateSession('sess_1', { agent: { model: '' } })).toBeUndefined()
    expect(registry.updateSession('sess_1', { agent: { model: null } })).toBeUndefined()
    expect(registry.updateSession('missing', {})).toBeUndefined()

    const turn = registry.createTurn('sess_1')
    expect(turn?.status).toBe('in_progress')
    expect(registry.getCurrentTurn('sess_1')?.id).toBe(turn?.id)
    expect(registry.createTurn('missing')).toBeUndefined()
    expect(registry.getCurrentTurn('missing')).toBeUndefined()

    registry.appendItems('sess_1', [{
      id: 'item_1',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
      status: 'completed',
      turn_id: turn!.id,
    }])
    registry.appendItems('sess_1', [])
    registry.appendItems('missing', [{
      id: 'item_x',
      type: 'message',
      role: 'user',
      content: [],
      status: 'completed',
      turn_id: 't',
    }])
    expect(registry.listItems('sess_1', { limit: 20 }).data).toHaveLength(1)
    expect(registry.listItems('sess_1', { limit: 20, order: 'desc' }).data).toHaveLength(1)
    expect(registry.listTurns('sess_1', { limit: 20 }).data).toHaveLength(1)
    expect(registry.getTurn('sess_1', turn!.id)?.id).toBe(turn!.id)

    const completed = registry.completeTurn('sess_1', turn!.id, {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    })
    expect(completed?.status).toBe('completed')
    expect(registry.getCurrentTurn('sess_1')).toBeUndefined()
    expect(registry.completeTurn('missing', 't')).toBeUndefined()
    expect(registry.completeTurn('sess_1', 'nope')).toBeUndefined()

    const failedTurn = registry.createTurn('sess_1')!
    expect(registry.failTurn('sess_1', failedTurn.id, { code: 'x', message: 'boom' })?.status).toBe('failed')
    const leftover = registry.createTurn('sess_1')!
    const older = registry.createTurn('sess_1')!
    expect(registry.completeTurn('sess_1', leftover.id)?.status).toBe('completed')
    expect(registry.getCurrentTurn('sess_1')?.id).toBe(older.id)
    expect(registry.listTurns('sess_1', { limit: 20, order: 'asc' }).data.length).toBeGreaterThan(1)
    expect(registry.failTurn('missing', 't', { code: 'x', message: 'boom' })).toBeUndefined()
    expect(registry.failTurn('sess_1', 'nope', { code: 'x', message: 'boom' })).toBeUndefined()

    const cancelTurn = registry.createTurn('sess_1')!
    expect(registry.cancelTurn('sess_1', cancelTurn.id)?.status).toBe('cancelled')
    expect(registry.cancelTurn('missing', 't')).toBeUndefined()
    expect(registry.cancelTurn('sess_1', 'nope')).toBeUndefined()

    const events: string[] = []
    const off = registry.subscribe('sess_1', (evt) => {
      events.push(evt.type)
    })
    const boom = registry.subscribe('sess_1', () => {
      throw new Error('disconnected')
    })
    registry.emit('sess_1', {
      type: 'agent.session.idle',
      event_id: 'evt_1',
      session: registry.getOAISession('sess_1')!,
    })
    registry.emit('missing', {
      type: 'agent.session.idle',
      event_id: 'evt_x',
      session: registry.getOAISession('sess_1')!,
    })
    expect(events).toEqual(['agent.session.idle'])
    off()
    boom()
    registry.register('sess_2', agent)
    expect(registry.list({ limit: 20, order: 'asc' }).data).toHaveLength(2)
    expect(registry.listTurns('missing', { limit: 20 }).data).toEqual([])
    expect(registry.listItems('missing', { limit: 20 }).data).toEqual([])
    expect(registry.getTurn('missing', 't')).toBeUndefined()
    expect(registry.delete('sess_1')).toBe(true)
    expect(registry.get('sess_1')).toBeUndefined()
  })
})
