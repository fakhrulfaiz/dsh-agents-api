import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

describe('apply', () => {
  it('registers the prefix handler and ignores events for unknown sessions', () => {
    const listeners: Array<(session: { id: string; header?: { origin?: string; parentSession?: string } }, event: { type: string; seq: number; time: number; data: unknown }) => void> = []
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
    const auth = { mode: 'development' as const, devKey: { key: 'k', owner: 'dev' } }
    apply(ctx as unknown as Context, { auth })
    apply(ctx as unknown as Context, { auth, prefix: '/v1' })
    expect(register).toHaveBeenCalledTimes(4)
    expect(listeners).toHaveLength(4)
    listeners[0]!({ id: 'missing', header: {} }, { type: 'turn/start', seq: 1, time: 1, data: {} })
  })
})
