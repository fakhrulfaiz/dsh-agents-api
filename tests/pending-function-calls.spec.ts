import { describe, expect, it, vi } from 'vitest'
import { PendingFunctionCalls } from '../src/pending-function-calls.ts'

const signal = () => new AbortController().signal

describe('PendingFunctionCalls', () => {
  it('parks until the client completes the call', async () => {
    const pending = new PendingFunctionCalls()
    const wait = pending.wait({ callId: 'c1', signal: signal() })
    expect(pending.has('c1')).toBe(true)

    expect(pending.complete('c1', { success: true, output: 'ok' })).toBe(true)
    await expect(wait).resolves.toBe('ok')
    expect(pending.has('c1')).toBe(false)
  })

  it('rejects on abort, failure outcome, and rejectAll', async () => {
    const pending = new PendingFunctionCalls()

    const controller = new AbortController()
    const aborted = pending.wait({ callId: 'c_abort', signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toThrow(/cancelled/)

    const failed = pending.wait({ callId: 'c_fail', signal: signal() })
    expect(pending.complete('c_fail', { success: false, error: 'nope' })).toBe(true)
    await expect(failed).rejects.toThrow('nope')

    const doomed = pending.wait({ callId: 'c_all', signal: signal() })
    pending.rejectAll(new Error('gone'))
    await expect(doomed).rejects.toThrow('gone')
    expect(pending.complete('missing', { success: true, output: 'x' })).toBe(false)
  })

  it('rejects duplicate waiters and already-aborted signals', async () => {
    const pending = new PendingFunctionCalls()
    void pending.wait({ callId: 'dup', signal: signal() }).catch(vi.fn())
    await expect(pending.wait({ callId: 'dup', signal: signal() })).rejects.toThrow(/already waiting/)

    const aborted = new AbortController()
    aborted.abort()
    await expect(pending.wait({ callId: 'early', signal: aborted.signal })).rejects.toThrow(/before it started/)
  })
})
