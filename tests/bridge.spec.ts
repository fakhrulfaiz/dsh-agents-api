import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { materializeAgent } from '../src/agent-store.ts'
import { bridgeSessionEvent, mintEventId } from '../src/bridge.ts'
import { SessionRegistry } from '../src/session-registry.ts'

function event(type: SessionEvent['type'], data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

describe('bridgeSessionEvent', () => {
  it('mints unique event ids', () => {
    expect(mintEventId().startsWith('evt_')).toBe(true)
    expect(mintEventId()).not.toBe(mintEventId())
  })

  it('ignores unknown sessions and projects turn plus assistant events', () => {
    const registry = new SessionRegistry()
    bridgeSessionEvent('missing', event('turn/start', { turn: 1 }), registry)

    registry.register('sess_1', materializeAgent({ model: 'deepseek-chat' }))
    const seen: string[] = []
    registry.subscribe('sess_1', (evt) => {
      seen.push(evt.type)
    })

    bridgeSessionEvent('sess_1', event('turn/start', { turn: 1 }), registry)
    bridgeSessionEvent('sess_1', event('user/message', { content: [{ type: 'text', text: 'hi' }] }), registry)
    bridgeSessionEvent('sess_1', event('assistant/message', {
      message: { content: [{ type: 'text', text: 'ok' }] },
      stream: [{ type: 'text-chunks', texts: ['o', 'k'] }],
    }), registry)
    bridgeSessionEvent('sess_1', event('turn/end', {
      usage: { inputTokens: 1, outputTokens: 1 },
    }), registry)

    expect(seen).toContain('agent.session.turn.created')
    expect(seen).toContain('agent.session.turn.output_text.delta')
    expect(seen).toContain('agent.session.turn.completed')
    expect(seen).toContain('agent.session.idle')
    expect(registry.listItems('sess_1', { limit: 20 }).data.length).toBeGreaterThan(0)
  })

  it('emits a single delta when the assistant stream is empty', () => {
    const registry = new SessionRegistry()
    registry.register('sess_2', materializeAgent({ model: 'deepseek-chat' }))
    const deltas: string[] = []
    registry.subscribe('sess_2', (evt) => {
      if (evt.type === 'agent.session.turn.output_text.delta') deltas.push(evt.delta)
    })
    bridgeSessionEvent('sess_2', event('turn/start', { turn: 1 }), registry)
    bridgeSessionEvent('sess_2', event('assistant/message', {
      message: { content: 'only-body' },
    }), registry)
    expect(deltas).toEqual(['only-body'])
  })

  it('ignores unknown event types and completes a turn without usage', () => {
    const registry = new SessionRegistry()
    registry.register('sess_3', materializeAgent({ model: 'deepseek-chat' }))
    bridgeSessionEvent('sess_3', { type: 'unknown/type', seq: 1, time: 1, data: {} } as unknown as SessionEvent, registry)
    bridgeSessionEvent('sess_3', event('turn/start', { turn: 1 }), registry)
    bridgeSessionEvent('sess_3', event('turn/end', {}), registry)
    expect(registry.getOAISession('sess_3')?.status).toBe('idle')
  })

  it('reuses an open turn and ignores turn/end without one', () => {
    const registry = new SessionRegistry()
    registry.register('sess_4', materializeAgent({ model: 'deepseek-chat' }))
    registry.createTurn('sess_4')
    const seen: string[] = []
    registry.subscribe('sess_4', (evt) => {
      seen.push(evt.type)
    })
    bridgeSessionEvent('sess_4', event('turn/start', { turn: 1 }), registry)
    expect(seen).toContain('agent.session.turn.created')
    const other = new SessionRegistry()
    other.register('sess_5', materializeAgent({ model: 'deepseek-chat' }))
    bridgeSessionEvent('sess_5', event('turn/end', {}), other)
    expect(other.getOAISession('sess_5')?.status).toBe('idle')
    bridgeSessionEvent('sess_5', event('assistant/message', {
      message: { content: '' },
      stream: [{ type: 'text-chunks' }],
    }), other)
  })
})
