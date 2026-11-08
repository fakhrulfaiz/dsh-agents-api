/**
 * Development authenticator: one fixed bearer key mapped to one owner.
 */

import { timingSafeEqual } from 'node:crypto'
import type { Authenticator, Role } from './authenticator.ts'
import { bearerToken, ownerId, unauthenticated } from './authenticator.ts'

/**
 * @param cfg - the accepted key, the owner it maps to, and whether it carries the admin role.
 * @returns an authenticator that accepts exactly `cfg.key`.
 */
export function createStaticKeyAuthenticator(cfg: { key: string; owner: string; admin: boolean }): Authenticator {
  const expected = Buffer.from(cfg.key)
  const roles = new Set<Role>(cfg.admin ? ['agentry-user', 'agentry-admin'] : ['agentry-user'])
  const owner = ownerId(cfg.owner)
  return {
    authenticate(req) {
      const token = bearerToken(req)
      if (token === undefined) return Promise.resolve(unauthenticated('Missing bearer token'))
      const given = Buffer.from(token)
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return Promise.resolve(unauthenticated('Invalid API key provided'))
      }
      return Promise.resolve({ ok: true, principal: { owner, roles } })
    },
  }
}
