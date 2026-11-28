/**
 * Sealing of per-owner secrets (connector keys) with AES-256-GCM.
 *
 * The AES key is derived with HKDF-SHA256 from `secrets.key` (`AGENTRY_SECRETS_KEY`); the owner
 * id and the secret's name are bound as authenticated data, so a sealed value cannot be moved to
 * another owner or name. Same layout as `agentry-sandbox/src/crypto/secrets.ts`:
 * base64 of iv(12) | tag(16) | ciphertext.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/** A sealed value could not be opened: tampered, another owner or name, or a different key. */
export class SecretOpenError extends Error {
  constructor() {
    super('the sealed secret could not be opened (tampered, moved, or sealed under a different key)')
    this.name = 'SecretOpenError'
  }
}

const derived = (key: string): Buffer => Buffer.from(hkdfSync('sha256', key, 'agentry-api', 'agentry-api owner secrets v1', 32))

const aad = (owner: string, name: string): Buffer => Buffer.from(`${owner}\0${name}`, 'utf8')

/**
 * @param key - `secrets.key`.
 * @param owner - owner id the value belongs to.
 * @param name - secret name, for example `composio`.
 * @param value - plain value.
 * @returns base64 of iv | tag | ciphertext.
 */
export function sealSecret(key: string, owner: string, name: string, value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derived(key), iv)
  cipher.setAAD(aad(owner, name))
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

/**
 * @param key - `secrets.key`.
 * @param owner - owner id the value was sealed for.
 * @param name - secret name it was sealed under.
 * @param sealed - output of {@link sealSecret}.
 * @returns the plain value.
 * @throws SecretOpenError when the value cannot be opened.
 */
export function openSecret(key: string, owner: string, name: string, sealed: string): string {
  const buf = Buffer.from(sealed, 'base64')
  if (buf.length < 28) throw new SecretOpenError()
  try {
    const decipher = createDecipheriv('aes-256-gcm', derived(key), buf.subarray(0, 12))
    decipher.setAAD(aad(owner, name))
    decipher.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretOpenError()
  }
}

/** The last four characters of a secret, the only part ever shown. */
export function last4(value: string): string {
  return value.slice(-4)
}
