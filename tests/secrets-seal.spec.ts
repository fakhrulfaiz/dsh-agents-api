import { describe, expect, it } from 'vitest'
import { last4, openSecret, SecretOpenError, sealSecret } from '../src/secrets/seal.ts'

const KEY = 'k'.repeat(48)

describe('owner secret sealing', () => {
  it('round-trips and never contains the plain value', () => {
    const sealed = sealSecret(KEY, 'owner-a', 'composio', 'ck_abcdef1234')
    expect(sealed).not.toContain('ck_abcdef1234')
    expect(Buffer.from(sealed, 'base64').length).toBe(12 + 16 + 'ck_abcdef1234'.length)
    expect(openSecret(KEY, 'owner-a', 'composio', sealed)).toBe('ck_abcdef1234')
  })

  it('refuses another owner, another name, another key and tampering', () => {
    const sealed = sealSecret(KEY, 'owner-a', 'composio', 'ck_abcdef1234')
    expect(() => openSecret(KEY, 'owner-b', 'composio', sealed)).toThrow(SecretOpenError)
    expect(() => openSecret(KEY, 'owner-a', 'openai', sealed)).toThrow(SecretOpenError)
    expect(() => openSecret('x'.repeat(48), 'owner-a', 'composio', sealed)).toThrow(SecretOpenError)
    const bytes = Buffer.from(sealed, 'base64')
    bytes[bytes.length - 1]! ^= 1
    expect(() => openSecret(KEY, 'owner-a', 'composio', bytes.toString('base64'))).toThrow(SecretOpenError)
    expect(() => openSecret(KEY, 'owner-a', 'composio', 'short')).toThrow(SecretOpenError)
  })

  it('shows only the last four characters', () => {
    expect(last4('ck_abcdef1234')).toBe('1234')
  })
})
