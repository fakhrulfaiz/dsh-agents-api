import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

describe('apply', () => {
  it('registers the prefix handler and ignores events for unknown sessions', () => {
    const listeners: Array<(session: { id: string }, event: { type: string; seq: number; time: number; data: unknown }) => void> = []
    const register = vi.fn(() => () => {})
    const ctx = {
      on(_name: string, fn: (typeof listeners)[number]) {
        listeners.push(fn)
        return () => {}
      },
      effect(fn: () => () => void) {
        return fn()
      },
      webServer: { register },
    }
    apply(ctx as unknown as Context)
    apply(ctx as unknown as Context, { apiKey: 'k', prefix: '/v1' })
    expect(register).toHaveBeenCalledTimes(2)
    expect(listeners).toHaveLength(2)
    listeners[0]!({ id: 'missing' }, { type: 'turn/start', seq: 1, time: 1, data: {} })
  })
})
