import { describe, expect, it, vi } from 'vitest'
import { materializeAgent } from '../src/agent-store.ts'
import { PendingFunctionCalls } from '../src/pending-function-calls.ts'
import { SessionRegistry } from '../src/session-registry.ts'

describe('PendingFunctionCalls', () => {
  it('parks, emits requires_action, and completes', async () => {
    const registry = new SessionRegistry()
    const agent = materializeAgent({ model: 'deepseek-chat' })
    registry.register('sess_1', agent)
    registry.createTurn('sess_1')
    const pending = new PendingFunctionCalls('sess_1', registry)
    const events: string[] = []
    registry.subscribe('sess_1', (evt) => {
      events.push(evt.type)
    })

    const wait = pending.wait({
      callId: 'c1',
      name: 'lookup',
      arguments: { q: 1 },
      turnId: 'turn_1',
      signal: new AbortController().signal,
    })
    expect(pending.has('c1')).toBe(true)
    expect(registry.get('sess_1')?.status).toBe('requires_action')
    expect(events).toContain('agent.session.requires_action')

    expect(pending.complete('c1', { success: true, output: 'ok' })).toBe(true)
    await expect(wait).resolves.toBe('ok')
    expect(registry.get('sess_1')?.status).toBe('in_progress')
    expect(pending.has('c1')).toBe(false)
  })

  it('rejects on abort, failure outcome, and rejectAll', async () => {
    const registry = new SessionRegistry()
    registry.register('sess_1', materializeAgent({ model: 'deepseek-chat' }))
    registry.createTurn('sess_1')
    const pending = new PendingFunctionCalls('sess_1', registry)

    const controller = new AbortController()
    const aborted = pending.wait({
      callId: 'c_abort',
      name: 'a',
      arguments: {},
      turnId: 't',
      signal: controller.signal,
    })
    controller.abort()
    await expect(aborted).rejects.toThrow(/cancelled/)

    const failed = pending.wait({
      callId: 'c_fail',
      name: 'a',
      arguments: {},
      turnId: 't',
      signal: new AbortController().signal,
    })
    expect(pending.complete('c_fail', { success: false, error: 'nope' })).toBe(true)
    await expect(failed).rejects.toThrow('nope')

    const doomed = pending.wait({
      callId: 'c_all',
      name: 'a',
      arguments: {},
      turnId: 't',
      signal: new AbortController().signal,
    })
    pending.rejectAll(new Error('gone'))
    await expect(doomed).rejects.toThrow('gone')
    expect(pending.complete('missing', { success: true, output: 'x' })).toBe(false)
  })

  it('rejects duplicate waiters and already-aborted signals', async () => {
    const registry = new SessionRegistry()
    registry.register('sess_1', materializeAgent({ model: 'deepseek-chat' }))
    const pending = new PendingFunctionCalls('sess_1', registry)
    const signal = new AbortController().signal
    void pending.wait({
      callId: 'dup',
      name: 'a',
      arguments: {},
      turnId: 't',
      signal,
    }).catch(vi.fn())
    await expect(pending.wait({
      callId: 'dup',
      name: 'a',
      arguments: {},
      turnId: 't',
      signal,
    })).rejects.toThrow(/already waiting/)

    const aborted = new AbortController()
    aborted.abort()
    await expect(pending.wait({
      callId: 'early',
      name: 'a',
      arguments: {},
      turnId: 't',
      signal: aborted.signal,
    })).rejects.toThrow(/before it started/)
  })
})
