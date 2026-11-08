/**
 * Production authenticator: Keycloak-issued JWTs verified against the realm JWKS.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Authenticator, Role } from './authenticator.ts'
import { bearerToken, ownerId, unauthenticated } from './authenticator.ts'

const KNOWN_ROLES: readonly Role[] = ['agentry-user', 'agentry-admin']

/**
 * @param cfg - realm issuer URL, expected `aud`, and JWKS cache lifetime.
 * @returns an authenticator verifying signature, `iss`, `aud`, and expiry; owner is `sub`, roles come from `realm_access.roles`.
 */
export function createKeycloakAuthenticator(cfg: {
  issuer: string
  audience: string
  jwksTtlSeconds: number
}): Authenticator {
  const jwks = createRemoteJWKSet(new URL(`${cfg.issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`), {
    cacheMaxAge: cfg.jwksTtlSeconds * 1000,
    cooldownDuration: 0,
  })
  return {
    async authenticate(req) {
      const token = bearerToken(req)
      if (token === undefined) return unauthenticated('Missing bearer token')
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer: cfg.issuer, audience: cfg.audience })
        if (typeof payload.sub !== 'string' || payload.sub === '') return unauthenticated('Token has no subject')
        const claimed = (payload['realm_access'] as { roles?: unknown } | undefined)?.roles
        const names = Array.isArray(claimed) ? claimed : []
        const roles = new Set(KNOWN_ROLES.filter(role => names.includes(role)))
        return { ok: true, principal: { owner: ownerId(payload.sub), roles } }
      } catch {
        // jose throws one error class per rejection reason; all of them mean "not authenticated" and the token is never echoed.
        return unauthenticated('Invalid or expired token')
      }
    },
  }
}
