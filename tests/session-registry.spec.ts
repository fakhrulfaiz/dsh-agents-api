import { describe, expect, it } from 'vitest'
import { materializeAgent } from '../src/agent-records.ts'
import { WireProjector, type ProjectionBase } from '../src/history/projector.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { logEvent } from './support/fake-session-query.ts'

function base(id: string): ProjectionBase {
  return {
    sessionId: id,
    createdAt: 1,
    agent: materializeAgent({ model: 'deepseek-chat' }),
    environment: { type: 'none' },
    metadata: { k: 'v' },
    vaultIds: [],
  }
}

function registryWith(id: string): SessionRegistry {
  const registry = new SessionRegistry()
  registry.register(new WireProjector(base(id), false), '/w')
  return registry
}

describe('SessionRegistry', () => {
  it('exposes the live resource and applies settings updates', () => {
    const registry = registryWith('sess_1')
    expect(registry.getOAISession('sess_1')).toMatchObject({ status: 'idle', metadata: { k: 'v' } })
    expect(registry.getOAISession('missing')).toBeUndefined()
    expect(registry.get('sess_1')?.workspace).toBe('/w')

    const updated = registry.updateSession('sess_1', {
      agent: { model: 'deepseek-v4-flash', reasoning: { effort: 'low' }, service_tier: 'flex' },
      metadata: { n: '1' },
    })
    expect(updated?.agent).toMatchObject({ model: 'deepseek-v4-flash', reasoning: { effort: 'low' }, service_tier: 'flex' })
    expect(updated?.metadata).toEqual({ n: '1' })
    expect(registry.updateSession('sess_1', { metadata: null })?.metadata).toEqual({})
    expect(registry.updateSession('sess_1', { agent: { service_tier: null } })?.agent.service_tier).toBeNull()
    expect(registry.updateSession('sess_1', { agent: { reasoning: {} } })?.agent.reasoning).toEqual({ effort: 'low' })
    expect(registry.updateSession('sess_1', { agent: { model: '' } })).toBeUndefined()
    expect(registry.updateSession('sess_1', { agent: { model: null } })).toBeUndefined()
    expect(registry.updateSession('missing', {})).toBeUndefined()
    expect(registry.applyConfig('missing', { agent: base('x').agent, environment: { type: 'none' }, metadata: {}, vault_ids: [] })).toBeUndefined()
    registry.noteWorkspace('sess_1', '/other')
    registry.noteWorkspace('missing', '/other')
    expect(registry.get('sess_1')?.workspace).toBe('/other')
  })

  it('fans projected frames out with their ids and ephemeral events without one', () => {
    const registry = registryWith('sess_1')
    const seen: Array<[string, number | undefined]> = []
    const off = registry.subscribe('sess_1', (evt, id) => {
      seen.push([evt.type, id])
    })
    const boom = registry.subscribe('sess_1', () => {
      throw new Error('disconnected')
    })

    expect(registry.apply('missing', logEvent('turn/start', { turn: 1 }, 1))).toBeUndefined()
    expect(registry.getCurrentTurnId('sess_1')).toBeUndefined()
    const step = registry.apply('sess_1', logEvent('turn/start', { turn: 1 }, 5))
    expect(step?.status).toEqual({ status: 'in_progress', error: null })
    expect(registry.getCurrentTurnId('sess_1')).toBe('turn_5')
    registry.emitEphemeral('sess_1', {
      type: 'error',
      event_id: 'evt_x',
      error: { message: 'dispatch failed' },
    })
    registry.apply('sess_1', logEvent('turn/end', {}, 6))

    expect(seen).toEqual([
      ['agent.session.in_progress', 2],
      ['agent.session.turn.created', 3],
      ['agent.session.turn.in_progress', 4],
      ['error', undefined],
      ['agent.session.turn.completed', 5],
      ['agent.session.idle', 6],
    ])
    off()
    boom()
    registry.emitEphemeral('sess_1', { type: 'error', event_id: 'evt_y', error: { message: 'nobody listens' } })
    expect(seen).toHaveLength(6)
  })

  it('tracks subagents and drops them with the session', () => {
    const registry = registryWith('sess_1')
    expect(registry.ensureSubagent('missing', 'c')).toBeUndefined()
    expect(registry.ensureSubagent('sess_1', 'c')?.status).toBe('active')
    registry.closeSubagent('sess_1', 'c')
    expect(registry.getSubagent('sess_1', 'c')?.status).toBe('closed')
    expect(registry.delete('sess_1')).toBe(true)
    expect(registry.get('sess_1')).toBeUndefined()
    expect(registry.listSubagents('sess_1')).toEqual([])
  })
})
