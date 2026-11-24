import { describe, expect, it } from 'vitest'
import { materializeAgent } from '../src/agent-records.ts'
import { bridgeChildSessionEvent, mintEventId } from '../src/bridge.ts'
import { WireProjector } from '../src/history/projector.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { logEvent } from './support/fake-session-query.ts'

function registryWith(id: string): SessionRegistry {
  const registry = new SessionRegistry()
  registry.register(new WireProjector({
    sessionId: id,
    createdAt: 1,
    agent: materializeAgent({ model: 'deepseek-chat' }),
    environment: { type: 'none' },
    metadata: {},
    vaultIds: [],
  }, false))
  return registry
}

describe('bridgeChildSessionEvent', () => {
  it('mints unique event ids', () => {
    expect(mintEventId().startsWith('evt_')).toBe(true)
    expect(mintEventId()).not.toBe(mintEventId())
  })

  it('ignores children of sessions that are not live', () => {
    const registry = new SessionRegistry()
    bridgeChildSessionEvent('missing', 'child', logEvent('turn/start', { turn: 1 }, 1), registry)
    expect(registry.listSubagents('missing')).toEqual([])
  })

  it('records child turns and items on the child, not the parent', () => {
    const registry = registryWith('sess_1')
    bridgeChildSessionEvent('sess_1', 'child', logEvent('turn/start', { turn: 1 }, 1), registry)
    bridgeChildSessionEvent('sess_1', 'child', logEvent('user/message', {
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }, 2), registry)
    bridgeChildSessionEvent('sess_1', 'child', logEvent('turn/end', {}, 3), registry)

    expect(registry.listChildTurns('sess_1', 'child')?.map(turn => turn.status)).toEqual(['completed'])
    expect(registry.listChildItems('sess_1', 'child')?.[0]).toMatchObject({ subagent_id: 'child', role: 'user' })
    expect(registry.get('sess_1')?.projector.items).toEqual([])
  })

  it('marks a child turn failed with the logged error', () => {
    const registry = registryWith('sess_1')
    bridgeChildSessionEvent('sess_1', 'child', logEvent('turn/start', { turn: 1 }, 1), registry)
    bridgeChildSessionEvent('sess_1', 'child', logEvent('turn/end', { reason: { kind: 'error', error: { message: 'boom', code: 'E' } } }, 2), registry)
    expect(registry.listChildTurns('sess_1', 'child')?.[0]).toMatchObject({ status: 'failed', error: { code: 'E', message: 'boom' } })
  })

  it('times a child step from its start and a child tool call until its result', () => {
    const registry = registryWith('sess_1')
    const send = (type: string, data: unknown, seq: number, time: number) => bridgeChildSessionEvent('sess_1', 'child', logEvent(type, data, seq, time), registry)
    send('turn/start', { turn: 1 }, 1, 1_000)
    send('step/start', { turn: 1, step: 1 }, 2, 1_100)
    send('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] }, stream: [{ type: 'text-chunks', time0: 1_300, index: 0, dt: [0], texts: ['x'] }] }, 3, 1_500)
    send('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'glob', arguments: '{}' }, 4, 1_600)
    send('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } }, 5, 2_400)
    const items = registry.listChildItems('sess_1', 'child') ?? []
    expect(items.find(item => item.id === 'item_msg_3')).toMatchObject({ step: 1, timing: { started_at_ms: 1_100, first_token_at_ms: 1_300, completed_at_ms: 1_500 } })
    expect(items.find(item => item.id === 'item_fn_4')).toMatchObject({ timing: { started_at_ms: 1_600, completed_at_ms: 2_400 } })
  })
})
