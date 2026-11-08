/**
 * API-key authenticator for simple self-hosting: named keys held as SHA-256
 * hashes in config, each mapped to an owner and roles.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Authenticator, Principal, Role } from './authenticator.ts'
import { bearerToken, ownerId, unauthenticated } from './authenticator.ts'

/** One configured API key. The plaintext key is never stored. */
export interface ApiKeyEntry {
  /** Unique label, used for revocation bookkeeping and diagnostics. */
  name: string
  /** Owner id the key acts as. */
  owner: string
  /** Roles granted to the key; a non-empty subset of the recognised roles. */
  roles: Role[]
  /** `sha256:` followed by 64 lowercase hex characters: the SHA-256 of the full key. */
  hash: string
}

/** Prefix of every generated key. */
const KEY_PREFIX = 'agk_'

/** Pattern a stored `hash` must match. */
export const API_KEY_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

/**
 * Generate a new API key.
 * @returns `agk_` followed by the base64url encoding of 32 random bytes (47 characters).
 */
export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

/**
 * Hash a key for storage in config.
 * @param key - full plaintext key.
 * @returns `sha256:` plus the lowercase hex SHA-256 of `key`.
 */
export function hashApiKey(key: string): string {
  return `sha256:${createHash('sha256').update(key).digest('hex')}`
}

/** Raw 32-byte digest of a stored `sha256:<hex>` hash. */
function storedDigest(hash: string): Buffer {
  return Buffer.from(hash.slice('sha256:'.length), 'hex')
}

/**
 * @param entries - configured keys with valid `hash` values (validated by `Config`).
 * @returns an authenticator that accepts a bearer whose digest equals an entry's digest.
 *   The presented bearer is hashed once and compared with every entry using
 *   `timingSafeEqual`; the loop never exits at the matching entry.
 */
export function createApiKeyAuthenticator(entries: readonly ApiKeyEntry[]): Authenticator {
  const prepared = entries.map(entry => ({
    digest: storedDigest(entry.hash),
    principal: { owner: ownerId(entry.owner), roles: new Set<Role>(entry.roles) } satisfies Principal,
  }))
  return {
    authenticate(req) {
      const token = bearerToken(req)
      if (token === undefined) return Promise.resolve(unauthenticated('Missing bearer token'))
      const presented = createHash('sha256').update(token).digest()
      let matched: Principal | undefined
      for (const entry of prepared) {
        if (timingSafeEqual(presented, entry.digest)) matched ??= entry.principal
      }
      if (matched === undefined) return Promise.resolve(unauthenticated('Invalid API key provided'))
      return Promise.resolve({ ok: true, principal: matched })
    },
  }
}
