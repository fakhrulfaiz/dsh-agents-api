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
})
