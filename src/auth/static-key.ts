/**
 * Development authenticator: one fixed bearer key mapped to one owner.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { Authenticator, Role } from './authenticator.ts'
import { bearerToken, ownerId, unauthenticated } from './authenticator.ts'

/** SHA-256 digest, so the comparison is constant-length regardless of key length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * @param cfg - the accepted key, the owner it maps to, and whether it carries the admin role.
 * @returns an authenticator that accepts exactly `cfg.key`.
 */
export function createStaticKeyAuthenticator(cfg: { key: string; owner: string; admin: boolean }): Authenticator {
  const expected = digest(cfg.key)
  const roles = new Set<Role>(cfg.admin ? ['agentry-user', 'agentry-admin'] : ['agentry-user'])
  const owner = ownerId(cfg.owner)
  return {
    authenticate(req) {
      const token = bearerToken(req)
      if (token === undefined) return Promise.resolve(unauthenticated('Missing bearer token'))
      if (!timingSafeEqual(digest(token), expected)) {
        return Promise.resolve(unauthenticated('Invalid API key provided'))
      }
      return Promise.resolve({ ok: true, principal: { owner, roles } })
    },
  }
}
