/**
 * Authentication contract shared by the gateway and its authenticators.
 */

import type { IncomingMessage } from 'node:http'

/** Opaque owner identifier: the Keycloak token `sub` or the development key's configured owner. */
export type OwnerId = string & { readonly __brand: 'OwnerId' }

/** Realm roles the API recognises. */
export type Role = 'agentry-user' | 'agentry-admin'

/** Authenticated caller. */
export interface Principal {
  owner: OwnerId
  roles: ReadonlySet<Role>
}

/** Outcome of authenticating one request. */
export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; code: 'unauthenticated' | 'forbidden'; message: string }

/** Resolves the caller of an HTTP request. */
export interface Authenticator {
  /**
   * @param req - incoming request; credentials come from `Authorization`.
   * @returns the principal, or a 401/403 failure. Never throws for bad credentials.
   */
  authenticate(req: IncomingMessage): Promise<AuthResult>
}

/**
 * Brand a string as an owner id.
 * @param value - owner identifier from a verified credential or configuration.
 * @returns the branded id.
 */
export function ownerId(value: string): OwnerId {
  return value as OwnerId
}

/**
 * Build a 401 result.
 * @param message - human-readable reason; must not contain credentials.
 * @returns a failed `AuthResult`.
 */
export function unauthenticated(message: string): AuthResult {
  return { ok: false, status: 401, code: 'unauthenticated', message }
}

/**
 * Require a role on a successful result; failures pass through.
 * @param result - result from `Authenticator.authenticate`.
 * @param role - role the route needs.
 * @returns `result`, or a 403 failure when the principal lacks `role`.
 */
export function requireRole(result: AuthResult, role: Role): AuthResult {
  if (!result.ok || result.principal.roles.has(role)) return result
  return { ok: false, status: 403, code: 'forbidden', message: `Role "${role}" is required` }
}

/**
 * Require any one of several roles on a successful result; failures pass through.
 * @param result - result from `Authenticator.authenticate`.
 * @param roles - roles that each grant access.
 * @returns `result`, or a 403 failure when the principal holds none of `roles`.
 */
export function requireAnyRole(result: AuthResult, roles: readonly Role[]): AuthResult {
  if (!result.ok || roles.some(role => result.principal.roles.has(role))) return result
  return { ok: false, status: 403, code: 'forbidden', message: `One of the roles ${roles.map(r => `"${r}"`).join(', ')} is required` }
}

/**
 * Chain two authenticators: `second` runs only when `first` rejects the request.
 * @param first - tried first (the development key).
 * @param second - tried when `first` fails (Keycloak).
 * @returns an authenticator accepting what either accepts; the failure is `second`'s.
 */
export function firstThen(first: Authenticator, second: Authenticator): Authenticator {
  return {
    async authenticate(req) {
      const result = await first.authenticate(req)
      return result.ok ? result : second.authenticate(req)
    },
  }
}

/**
 * Extract the bearer token from an `Authorization` header.
 * @param req - incoming request.
 * @returns the token, or `undefined` when absent or not a Bearer credential.
 */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (header === undefined) return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match?.[1]
}
