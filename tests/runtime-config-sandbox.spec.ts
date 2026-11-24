import { describe, expect, it } from 'vitest'
import { resolveRuntimeConfig } from '../src/runtime-config.ts'

describe('sandbox runtime config', () => {
  it('is off unless both url and key are set', () => {
    expect(resolveRuntimeConfig({ workspaces: '/w' }, {}).sandbox).toBeUndefined()
  })

  it('reads config first, then AGENTRY_SANDBOX_URL / AGENTRY_SANDBOX_KEY', () => {
    expect(resolveRuntimeConfig({ workspaces: '/w', sandbox: { url: 'http://127.0.0.1:3090/', key: 'k1' } }, {}).sandbox).toEqual({ url: 'http://127.0.0.1:3090', key: 'k1' })
    expect(resolveRuntimeConfig({ workspaces: '/w' }, { AGENTRY_SANDBOX_URL: 'http://h:1', AGENTRY_SANDBOX_KEY: 'k2' }).sandbox).toEqual({ url: 'http://h:1', key: 'k2' })
  })

  it('rejects a url without a key (and the reverse), naming the missing field', () => {
    expect(() => resolveRuntimeConfig({ workspaces: '/w', sandbox: { url: 'http://h:1' } }, {})).toThrow(/sandbox\.key/)
    expect(() => resolveRuntimeConfig({ workspaces: '/w', sandbox: { key: 'k' } }, {})).toThrow(/sandbox\.url/)
    expect(() => resolveRuntimeConfig({ workspaces: '/w', sandbox: { url: 'not a url', key: 'k' } }, {})).toThrow(/sandbox\.url/)
  })
})
