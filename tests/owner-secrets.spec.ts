import { describe, expect, it, vi } from 'vitest'
import { ownerId } from '../src/auth/authenticator.ts'
import { Config } from '../src/index.ts'
import { OwnerSecrets, SecretsDisabledError, SecretsKeyTooShortError } from '../src/secrets/owner-secrets.ts'
import { MemoryStore } from './support/memory-store.ts'

const A = ownerId('owner-a')
const KEY = 'k'.repeat(48)
const VALUE = 'ck_live_value_9876'

async function setup(key: string | undefined = KEY) {
  const store = new MemoryStore()
  await store.ensureOwner(A)
  const warn = vi.fn()
  return { store, warn, secrets: new OwnerSecrets({ key, store: () => store, warn }) }
}

describe('OwnerSecrets', () => {
  it('stores sealed values and reports only last4', async () => {
    const { store, secrets } = await setup()
    expect(await secrets.status(A, 'composio')).toEqual({ configured: false, last4: null, updated_at: null })
    const saved = await secrets.set(A, 'composio', VALUE)
    expect(saved).toMatchObject({ configured: true, last4: '9876' })
    expect(JSON.stringify(saved)).not.toContain(VALUE)
    expect(JSON.stringify(await store.secrets.get(A, 'composio'))).not.toContain(VALUE)
    expect(await secrets.get(A, 'composio')).toBe(VALUE)
    expect(await secrets.remove(A, 'composio')).toEqual({ configured: false, last4: null, updated_at: null })
    expect(await secrets.get(A, 'composio')).toBeUndefined()
  })

  it('treats rows sealed under another key as missing and warns once per owner', async () => {
    const { store, secrets } = await setup()
    await secrets.set(A, 'composio', VALUE)
    const warn = vi.fn()
    const rotated = new OwnerSecrets({ key: 'z'.repeat(48), store: () => store, warn })
    expect(await rotated.get(A, 'composio')).toBeUndefined()
    expect(await rotated.status(A, 'composio')).toMatchObject({ configured: false })
    expect(await rotated.get(A, 'composio')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(VALUE)
  })

  it('is disabled without a key', async () => {
    const { secrets } = await setup('')
    expect(secrets.enabled).toBe(false)
    await expect(secrets.set(A, 'composio', VALUE)).rejects.toThrow(SecretsDisabledError)
    expect(await secrets.get(A, 'composio')).toBeUndefined()
  })

  it('refuses a key under 32 bytes, also at config validation', () => {
    expect(() => new OwnerSecrets({ key: 'short', store: () => new MemoryStore(), warn: () => undefined })).toThrow(SecretsKeyTooShortError)
    const base = { workspaces: '/tmp/w', database: { url: 'postgres://x' }, auth: { mode: 'development', devKey: { key: 'k', owner: 'dev' } } }
    expect(() => Config({ ...base, secrets: { key: 'short' } } as never)).toThrow(/at least 32 bytes/)
    expect(() => Config({ ...base, secrets: { key: KEY } } as never)).not.toThrow()
    expect(() => Config(base as never)).not.toThrow()
  })
})
