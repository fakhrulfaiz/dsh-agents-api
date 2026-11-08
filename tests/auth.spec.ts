import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose'
import { requireRole } from '../src/auth/authenticator.ts'
import { createKeycloakAuthenticator } from '../src/auth/keycloak.ts'
import { createStaticKeyAuthenticator } from '../src/auth/static-key.ts'
import { Config } from '../src/index.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

interface Signer { kid: string; privateKey: CryptoKey; jwk: JWK }

async function signer(kid: string): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  return { kid, privateKey, jwk: { ...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig' } }
}

async function jwksServer(initial: Signer): Promise<{ issuer: string; rotate(next: Signer): void }> {
  let current = initial
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/protocol/openid-connect/certs' ? { keys: [current.jwk] } : {}))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    issuer: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    rotate: (next) => { current = next },
  }
}

function token(key: Signer, claims: { iss: string; aud: string; sub?: string; exp?: string | number; roles?: string[] }): Promise<string> {
  return new SignJWT({ realm_access: { roles: claims.roles ?? [] } })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub ?? 'user-1')
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '5m')
    .sign(key.privateKey)
}

function request(bearer?: string): IncomingMessage {
  return { headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } } as IncomingMessage
}

describe('keycloak authenticator', () => {
  const audience = 'agentry'

  it('accepts a valid token', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = createKeycloakAuthenticator({ issuer, audience, jwksTtlSeconds: 600 })
    const result = await auth.authenticate(request(await token(key, { iss: issuer, aud: audience, sub: 'abc', roles: ['agentry-user', 'other'] })))
    expect(result).toEqual({ ok: true, principal: { owner: 'abc', roles: new Set(['agentry-user']) } })
  })

  it('rejects missing and malformed credentials', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = createKeycloakAuthenticator({ issuer, audience, jwksTtlSeconds: 600 })
    expect(await auth.authenticate(request())).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' })
    expect(await auth.authenticate(request('not-a-jwt'))).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' })
  })

  it('rejects expired token', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = createKeycloakAuthenticator({ issuer, audience, jwksTtlSeconds: 600 })
    const expired = await token(key, { iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) - 3600 })
    expect(await auth.authenticate(request(expired))).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' })
  })

  it('rejects wrong issuer', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = createKeycloakAuthenticator({ issuer, audience, jwksTtlSeconds: 600 })
    expect(await auth.authenticate(request(await token(key, { iss: 'http://elsewhere', aud: audience })))).toMatchObject({ ok: false, status: 401 })
  })

  it('rejects wrong audience', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = createKeycloakAuthenticator({ issuer, audience, jwksTtlSeconds: 600 })
    expect(await auth.authenticate(request(await token(key, { iss: issuer, aud: 'other' })))).toMatchObject({ ok: false, status: 401 })
  })

  it('refetches JWKS on unknown kid', async () => {
    const first = await signer('k1')
    const server = await jwksServer(first)
    const auth = createKeycloakAuthenticator({ issuer: server.issuer, audience, jwksTtlSeconds: 600 })
    expect((await auth.authenticate(request(await token(first, { iss: server.issuer, aud: audience })))).ok).toBe(true)
    const second = await signer('k2')
    server.rotate(second)
    expect((await auth.authenticate(request(await token(second, { iss: server.issuer, aud: audience })))).ok).toBe(true)
  })
})

describe('requireRole', () => {
  it('forbids missing admin role', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = createKeycloakAuthenticator({ issuer, audience: 'agentry', jwksTtlSeconds: 600 })
    const result = await auth.authenticate(request(await token(key, { iss: issuer, aud: 'agentry', roles: ['agentry-user'] })))
    expect(requireRole(result, 'agentry-admin')).toMatchObject({ ok: false, status: 403, code: 'forbidden' })
    expect(requireRole(result, 'agentry-user').ok).toBe(true)
  })

  it('passes authentication failures through', () => {
    const failure = { ok: false, status: 401, code: 'unauthenticated', message: 'x' } as const
    expect(requireRole(failure, 'agentry-admin')).toBe(failure)
  })
})

describe('static key authenticator', () => {
  it('maps the key to the configured owner', async () => {
    const auth = createStaticKeyAuthenticator({ key: 'secret', owner: 'dev', admin: false })
    expect(await auth.authenticate(request('secret'))).toEqual({ ok: true, principal: { owner: 'dev', roles: new Set(['agentry-user']) } })
    expect(await auth.authenticate(request('wrong'))).toMatchObject({ ok: false, status: 401 })
    expect(await auth.authenticate(request())).toMatchObject({ ok: false, status: 401 })
  })

  it('grants admin when configured', async () => {
    const auth = createStaticKeyAuthenticator({ key: 'secret', owner: 'dev', admin: true })
    const result = await auth.authenticate(request('secret'))
    expect(requireRole(result, 'agentry-admin').ok).toBe(true)
  })
})

describe('auth Config', () => {
  const keycloak = { issuer: 'http://kc/realms/r', audience: 'agentry' }
  const devKey = { key: 'k', owner: 'dev' }

  it('production mode rejects devKey config', () => {
    expect(() => Config({ auth: { mode: 'production', keycloak, devKey } } as never)).toThrow(/devKey/)
  })

  it('production mode requires keycloak', () => {
    expect(() => Config({ auth: { mode: 'production' } } as never)).toThrow(/keycloak/)
  })

  it('development mode needs devKey or keycloak', () => {
    expect(() => Config({ auth: { mode: 'development' } } as never)).toThrow(/devKey/)
    expect(Config({ auth: { mode: 'development', devKey } } as never).auth?.devKey).toMatchObject({ owner: 'dev', admin: true })
  })

  it('applies keycloak defaults', () => {
    expect(Config({ auth: { mode: 'production', keycloak } } as never).auth?.keycloak?.jwksTtlSeconds).toBe(600)
  })
})
