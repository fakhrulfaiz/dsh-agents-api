import { describe, expect, it } from 'vitest'
import { materializeAgent } from '../src/agent-records.ts'
import { WireProjector, type ProjectionBase } from '../src/history/projector.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import type { OAIRequiredAction } from '../src/types.ts'
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

  describe('pending approvals', () => {
    const approval: OAIRequiredAction = { type: 'approval', id: 'appr-1', kind: 'tool_approval', prompt: 'Approve bash', options: ['approve', 'deny'] }
    const withFunctionTool = (): SessionRegistry => {
      const registry = new SessionRegistry()
      const seed = base('sess_1')
      registry.register(new WireProjector({ ...seed, agent: { ...seed.agent, tools: [{ type: 'function', name: 'lookup' }] } }, false), '/w')
      return registry
    }

    it('shows them in required_actions, moves the status, and sends ephemeral frames', () => {
      const registry = registryWith('sess_1')
      const seen: Array<[string, number | undefined]> = []
      registry.subscribe('sess_1', (evt, id) => { seen.push([evt.type, id]) })
      expect(registry.setInteractionActions('missing', [approval])).toBeUndefined()
      registry.apply('sess_1', logEvent('turn/start', { turn: 1 }, 1))
      seen.length = 0

      expect(registry.setInteractionActions('sess_1', [approval])).toEqual({ status: 'requires_action', error: null })
      expect(registry.getOAISession('sess_1')).toMatchObject({ status: 'requires_action', required_actions: [approval] })
      expect(registry.setInteractionActions('sess_1', [approval, { ...approval, id: 'appr-2' }])).toBeUndefined()
      expect(registry.setInteractionActions('sess_1', [])).toEqual({ status: 'in_progress', error: null })
      expect(registry.getOAISession('sess_1')).toMatchObject({ status: 'in_progress', required_actions: [] })
      expect(seen).toEqual([
        ['agent.session.requires_action', undefined],
        ['agent.session.requires_action', undefined],
        ['agent.session.in_progress', undefined],
      ])
    })

    it('does not change the status or move frame ids when no turn is open', () => {
      const registry = registryWith('sess_1')
      expect(registry.setInteractionActions('sess_1', [approval])).toBeUndefined()
      expect(registry.getOAISession('sess_1')?.status).toBe('idle')
      expect(registry.setInteractionActions('sess_1', [])).toBeUndefined()
    })

    it('keeps requires_action while a function call and an approval overlap', () => {
      const registry = withFunctionTool()
      registry.apply('sess_1', logEvent('turn/start', { turn: 1 }, 1))
      registry.apply('sess_1', logEvent('tool/call', { callId: 'c', name: 'lookup', arguments: '{}' }, 2))
      registry.setInteractionActions('sess_1', [approval])
      const result = logEvent('tool/result', {
        message: { source: { kind: 'tool', callId: 'c' }, content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'ok' }] }] },
      }, 3)
      expect(registry.apply('sess_1', result)?.status).toBeUndefined()
      expect(registry.getOAISession('sess_1')).toMatchObject({ status: 'requires_action', required_actions: [approval] })
      expect(registry.setInteractionActions('sess_1', [])).toEqual({ status: 'in_progress', error: null })
    })

    it('drops them when the turn ends', () => {
      const registry = registryWith('sess_1')
      registry.apply('sess_1', logEvent('turn/start', { turn: 1 }, 1))
      registry.setInteractionActions('sess_1', [approval])
      registry.apply('sess_1', logEvent('turn/end', {}, 2))
      expect(registry.getOAISession('sess_1')).toMatchObject({ status: 'idle', required_actions: [] })
    })
  })
})
