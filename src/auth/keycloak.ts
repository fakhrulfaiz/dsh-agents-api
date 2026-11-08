/**
 * Production authenticator: Keycloak-issued JWTs verified against the realm JWKS.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Authenticator, Role } from './authenticator.ts'
import { bearerToken, ownerId, unauthenticated } from './authenticator.ts'

const KNOWN_ROLES: readonly Role[] = ['agentry-user', 'agentry-admin']

/** Keycloak verification settings; defaults are applied by the plugin `Config`. */
export interface KeycloakAuthConfig {
  /** Realm issuer URL, matched against `iss`. */
  issuer: string
  /** Required `aud`. */
  audience: string
  /** JWKS cache lifetime in seconds. */
  jwksTtlSeconds: number
  /** Minimum seconds between JWKS refetches triggered by an unknown `kid`; 0 refetches on every unknown `kid`. */
  jwksCooldownSeconds: number
  /** Accepted JWS algorithms. */
  algorithms: string[]
  /** Allowed clock skew in seconds for `exp` and `nbf`. */
  clockToleranceSeconds: number
  /** Receives rejection diagnostics (jose error code only, never the token). */
  warn: (message: string) => void
}

/**
 * @param cfg - verification settings.
 * @returns an authenticator verifying signature, `iss`, `aud`, `exp`, `sub`, and `typ: Bearer`; owner is `sub`, roles come from `realm_access.roles`.
 */
export function createKeycloakAuthenticator(cfg: KeycloakAuthConfig): Authenticator {
  const jwks = createRemoteJWKSet(new URL(`${cfg.issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`), {
    cacheMaxAge: cfg.jwksTtlSeconds * 1000,
    cooldownDuration: cfg.jwksCooldownSeconds * 1000,
  })
  return {
    async authenticate(req) {
      const token = bearerToken(req)
      if (token === undefined) return unauthenticated('Missing bearer token')
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: cfg.issuer,
          audience: cfg.audience,
          algorithms: cfg.algorithms,
          clockTolerance: cfg.clockToleranceSeconds,
          requiredClaims: ['exp', 'sub'],
        })
        if (payload['typ'] !== 'Bearer') return unauthenticated('Token is not an access token')
        const claimed = (payload['realm_access'] as { roles?: unknown } | undefined)?.roles
        const names = Array.isArray(claimed) ? claimed : []
        const roles = new Set(KNOWN_ROLES.filter(role => names.includes(role)))
        return { ok: true, principal: { owner: ownerId(payload.sub as string), roles } }
      } catch (error) {
        // jose errors carry a stable `code`; other failures (network) log the error class name. Neither includes the token.
        const code = (error as { code?: unknown }).code
        cfg.warn(`keycloak token rejected: ${typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown'}`)
        return unauthenticated('Invalid or expired token')
      }
    },
  }
}
