import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, base64url, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose'
import type { AuthResult, Authenticator, OwnerId } from '../src/auth/authenticator.ts'
import type { KeycloakAuthConfig } from '../src/auth/keycloak.ts'
import { firstThen, requireAnyRole, requireRole } from '../src/auth/authenticator.ts'
import { createKeycloakAuthenticator } from '../src/auth/keycloak.ts'
import { createStaticKeyAuthenticator } from '../src/auth/static-key.ts'
import { CodeboxRemovedError, Config, createAuthenticator } from '../src/index.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

interface Signer { kid: string; privateKey: CryptoKey; jwk: JWK }

async function signer(kid: string): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  return { kid, privateKey, jwk: { ...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig' } }
}

async function jwksServer(initial: Signer): Promise<{ issuer: string; rotate(next: Signer): void; fetches(): number }> {
  let current = initial
  let fetched = 0
  const server = createServer((req, res) => {
    if (req.url === '/protocol/openid-connect/certs') fetched += 1
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/protocol/openid-connect/certs' ? { keys: [current.jwk] } : {}))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    issuer: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    rotate: (next) => { current = next },
    fetches: () => fetched,
  }
}

function token(key: Signer, claims: { iss: string; aud: string; sub?: string | null; exp?: string | number | null; roles?: string[]; typ?: string }): Promise<string> {
  const jwt = new SignJWT({ realm_access: { roles: claims.roles ?? [] }, typ: claims.typ ?? 'Bearer' })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt()
  if (claims.sub !== null) jwt.setSubject(claims.sub ?? 'user-1')
  if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? '5m')
  return jwt.sign(key.privateKey)
}

const warn = vi.fn<(message: string) => void>()

function kc(issuer: string, audience: string, extra: Partial<KeycloakAuthConfig> = {}): Authenticator {
  return createKeycloakAuthenticator({
    issuer, audience, jwksTtlSeconds: 600, jwksCooldownSeconds: 0, algorithms: ['RS256'], clockToleranceSeconds: 5, warn, ...extra,
  })
}

function request(bearer?: string): IncomingMessage {
  return { headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } } as IncomingMessage
}

describe('keycloak authenticator', () => {
  const audience = 'agentry'

  it('accepts a valid token', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    const result = await auth.authenticate(request(await token(key, { iss: issuer, aud: audience, sub: 'abc', roles: ['agentry-user', 'other'] })))
    expect(result).toEqual({ ok: true, principal: { owner: 'abc', roles: new Set(['agentry-user']) } })
  })

  it('rejects missing and malformed credentials', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    expect(await auth.authenticate(request())).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' })
    expect(await auth.authenticate(request('not-a-jwt'))).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' })
  })

  it('rejects expired token', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    const expired = await token(key, { iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) - 3600 })
    expect(await auth.authenticate(request(expired))).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' })
  })

  it('rejects wrong issuer', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    expect(await auth.authenticate(request(await token(key, { iss: 'http://elsewhere', aud: audience })))).toMatchObject({ ok: false, status: 401 })
  })

  it('rejects wrong audience', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    expect(await auth.authenticate(request(await token(key, { iss: issuer, aud: 'other' })))).toMatchObject({ ok: false, status: 401 })
  })

  it('refetches JWKS on unknown kid', async () => {
    const first = await signer('k1')
    const server = await jwksServer(first)
    const auth = kc(server.issuer, audience)
    expect((await auth.authenticate(request(await token(first, { iss: server.issuer, aud: audience })))).ok).toBe(true)
    const second = await signer('k2')
    server.rotate(second)
    expect((await auth.authenticate(request(await token(second, { iss: server.issuer, aud: audience })))).ok).toBe(true)
  })
})

describe('keycloak authenticator hardening', () => {
  const audience = 'agentry'
  const denied = { ok: false, status: 401, code: 'unauthenticated' }

  it('rejects tokens without exp or sub', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    expect(await auth.authenticate(request(await token(key, { iss: issuer, aud: audience, exp: null })))).toMatchObject(denied)
    expect(await auth.authenticate(request(await token(key, { iss: issuer, aud: audience, sub: null })))).toMatchObject(denied)
  })

  it('rejects an empty or non-string sub', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    expect(await auth.authenticate(request(await token(key, { iss: issuer, aud: audience, sub: '' })))).toMatchObject(denied)
    const numeric = await new SignJWT({ sub: 42 as unknown as string, typ: 'Bearer' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer).setAudience(audience).setExpirationTime('5m').sign(key.privateKey)
    expect(await auth.authenticate(request(numeric))).toMatchObject(denied)
  })

  it('rejects an ID token', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    expect(await auth.authenticate(request(await token(key, { iss: issuer, aud: audience, typ: 'ID' })))).toMatchObject(denied)
  })

  it('rejects a bad signature under a known kid', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    const forger = { ...await signer('k1') }
    expect(await auth.authenticate(request(await token(forger, { iss: issuer, aud: audience })))).toMatchObject(denied)
  })

  it('rejects alg none and HS256', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, audience)
    const claims = { iss: issuer, aud: audience, sub: 'u', exp: Math.floor(Date.now() / 1000) + 300, typ: 'Bearer' }
    const part = (value: object): string => base64url.encode(JSON.stringify(value))
    const none = `${part({ alg: 'none', kid: 'k1' })}.${part(claims)}.`
    expect(await auth.authenticate(request(none))).toMatchObject(denied)
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'))
    expect(await auth.authenticate(request(hs))).toMatchObject(denied)
  })

  it('applies the configured clock tolerance', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const expired = await token(key, { iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) - 30 })
    expect(await kc(issuer, audience, { clockToleranceSeconds: 0 }).authenticate(request(expired))).toMatchObject(denied)
    expect((await kc(issuer, audience, { clockToleranceSeconds: 60 }).authenticate(request(expired))).ok).toBe(true)
  })

  it('does not refetch JWKS for repeated unknown kids within the cooldown', async () => {
    const key = await signer('k1')
    const server = await jwksServer(key)
    const auth = kc(server.issuer, audience, { jwksCooldownSeconds: 30 })
    expect((await auth.authenticate(request(await token(key, { iss: server.issuer, aud: audience })))).ok).toBe(true)
    const before = server.fetches()
    const stranger = await signer('unknown')
    for (let i = 0; i < 5; i++) {
      expect(await auth.authenticate(request(await token(stranger, { iss: server.issuer, aud: audience })))).toMatchObject(denied)
    }
    expect(server.fetches() - before).toBeLessThanOrEqual(1)
  })

  it('answers 401 and logs only the error code when JWKS is unreachable', async () => {
    const key = await signer('k1')
    const server = await jwksServer(key)
    const issuer = server.issuer
    await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))))
    warn.mockClear()
    const jwt = await token(key, { iss: issuer, aud: audience })
    expect(await kc(issuer, audience).authenticate(request(jwt))).toMatchObject(denied)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/^keycloak token rejected: \w+$/)
    expect(warn.mock.calls[0]![0]).not.toContain(jwt)
  })
})

describe('requireAnyRole and firstThen', () => {
  it('requireAnyRole accepts either role and forbids neither', () => {
    const principal = (roles: Array<'agentry-user' | 'agentry-admin'>): AuthResult => ({ ok: true, principal: { owner: 'o' as OwnerId, roles: new Set(roles) } })
    const any = ['agentry-user', 'agentry-admin'] as const
    expect(requireAnyRole(principal(['agentry-admin']), any).ok).toBe(true)
    expect(requireAnyRole(principal([]), any)).toMatchObject({ ok: false, status: 403, code: 'forbidden' })
  })

  it('development with devKey and keycloak accepts either credential', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = createAuthenticator({
      mode: 'development',
      keycloak: { issuer, audience: 'agentry', jwksTtlSeconds: 600, jwksCooldownSeconds: 0, algorithms: ['RS256'], clockToleranceSeconds: 5 },
      devKey: { key: 'dev-secret', owner: 'dev', admin: true },
    }, warn)
    expect(await auth.authenticate(request('dev-secret'))).toMatchObject({ ok: true, principal: { owner: 'dev' } })
    expect(await auth.authenticate(request(await token(key, { iss: issuer, aud: 'agentry', sub: 'kc-user', roles: ['agentry-user'] })))).toMatchObject({ ok: true, principal: { owner: 'kc-user' } })
    expect(await auth.authenticate(request('nope'))).toMatchObject({ ok: false, status: 401 })
  })

  it('firstThen returns the second failure', async () => {
    const a = createStaticKeyAuthenticator({ key: 'a', owner: 'a', admin: false })
    const b = createStaticKeyAuthenticator({ key: 'b', owner: 'b', admin: false })
    expect(await firstThen(a, b).authenticate(request('b'))).toMatchObject({ ok: true, principal: { owner: 'b' } })
  })
})

describe('requireRole', () => {
  it('forbids missing admin role', async () => {
    const key = await signer('k1')
    const { issuer } = await jwksServer(key)
    const auth = kc(issuer, 'agentry')
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
  const database = { url: 'postgres://agentry@db/agentry' }
  const workspaces = '/data/workspaces'

  it('production mode rejects devKey config', () => {
    expect(() => Config({ workspaces, database, auth: { mode: 'production', keycloak, devKey } } as never)).toThrow(/devKey/)
  })

  it('production mode requires keycloak', () => {
    expect(() => Config({ workspaces, database, auth: { mode: 'production' } } as never)).toThrow(/keycloak/)
  })

  it('development mode needs devKey or keycloak', () => {
    expect(() => Config({ workspaces, database, auth: { mode: 'development' } } as never)).toThrow(/devKey/)
    expect(Config({ workspaces, database, auth: { mode: 'development', devKey } } as never).auth?.devKey).toMatchObject({ owner: 'dev', admin: true })
  })

  it('applies keycloak defaults', () => {
    expect(Config({ workspaces, database, auth: { mode: 'production', keycloak } } as never).auth?.keycloak).toMatchObject({
      jwksTtlSeconds: 600, jwksCooldownSeconds: 30, algorithms: ['RS256'], clockToleranceSeconds: 5,
    })
  })

  it('rejects empty or unsupported keycloak algorithms', () => {
    expect(() => Config({ workspaces, database, auth: { mode: 'production', keycloak: { ...keycloak, algorithms: [] } } } as never)).toThrow(/algorithms must not be empty/)
    expect(() => Config({ workspaces, database, auth: { mode: 'production', keycloak: { ...keycloak, algorithms: ['RS256', 'HS256', 'none'] } } } as never)).toThrow(/unsupported entries: HS256, none/)
    expect(Config({ workspaces, database, auth: { mode: 'production', keycloak: { ...keycloak, algorithms: ['ES256'] } } } as never).auth?.keycloak?.algorithms).toEqual(['ES256'])
  })

  it('rejects an empty devKey.key', () => {
    expect(() => Config({ workspaces, database, auth: { mode: 'development', devKey: { key: '', owner: 'dev' } } } as never)).toThrow(/empty/)
  })
})

describe('store and backend Config', () => {
  const auth = { mode: 'development', devKey: { key: 'k', owner: 'dev' } }
  const workspaces = '/data/workspaces'

  it('requires database.url', () => {
    expect(() => Config({ workspaces, auth } as never)).toThrow(/database/)
    expect(() => Config({ workspaces, auth, database: {} } as never)).toThrow(/url/)
    expect(Config({ workspaces, auth, database: { url: 'postgres://db/agentry' } } as never).database).toEqual({ url: 'postgres://db/agentry' })
  })

  it('requires workspaces', () => {
    expect(() => Config({ auth, database: { url: 'postgres://db/agentry' } } as never)).toThrow(/workspaces/)
    expect(() => Config({ workspaces: '  ', auth, database: { url: 'postgres://db/agentry' } } as never)).toThrow(/workspaces/)
  })

  it('codebox config is rejected as removed', () => {
    const codebox = { baseUrl: 'http://codebox', apiKey: 'k' }
    expect(() => Config({ workspaces, auth, database: { url: 'postgres://db/a' }, codebox } as never)).toThrow(CodeboxRemovedError)
    expect(() => Config({ workspaces, auth, database: { url: 'postgres://db/a' }, codebox } as never)).toThrow(/removed/)
  })

  it('rejects the removed dataDir and leaves S3 artifacts absent by default', () => {
    expect(() => Config({ workspaces, auth, database: { url: 'postgres://db/a' }, dataDir: './data' } as never)).toThrow(/dataDir/)
    expect(Config({ workspaces, auth, database: { url: 'postgres://db/a' } } as never).artifacts).toBeUndefined()
  })
})
