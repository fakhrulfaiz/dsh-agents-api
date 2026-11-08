import { execFile } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createApiKeyAuthenticator, generateApiKey, hashApiKey, type ApiKeyEntry } from '../src/auth/api-keys.ts'
import { Config, createAuthenticator } from '../src/index.ts'

const run = promisify(execFile)

function request(bearer?: string): IncomingMessage {
  return { headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } } as IncomingMessage
}

const keyA = generateApiKey()
const keyB = generateApiKey()
const entries: ApiKeyEntry[] = [
  { name: 'a', owner: 'ali', roles: ['agentry-user'], hash: hashApiKey(keyA) },
  { name: 'b', owner: 'bob', roles: ['agentry-user', 'agentry-admin'], hash: hashApiKey(keyB) },
]

describe('api key format', () => {
  it('generateApiKey format', () => {
    const key = generateApiKey()
    expect(key).toMatch(/^agk_[A-Za-z0-9_-]{43}$/)
    expect(key).toHaveLength(47)
    expect(generateApiKey()).not.toBe(key)
  })

  it('hashApiKey format', () => {
    expect(hashApiKey(keyA)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(hashApiKey(keyA)).toBe(hashApiKey(keyA))
    expect(hashApiKey(keyA)).not.toBe(hashApiKey(keyB))
  })
})

describe('api key authenticator', () => {
  const auth = createApiKeyAuthenticator(entries)

  it('accepts a configured key', async () => {
    expect(await auth.authenticate(request(keyA))).toEqual({ ok: true, principal: { owner: 'ali', roles: new Set(['agentry-user']) } })
    expect(await auth.authenticate(request(keyB))).toEqual({ ok: true, principal: { owner: 'bob', roles: new Set(['agentry-user', 'agentry-admin']) } })
  })

  it('rejects an unknown key, an empty bearer, and a missing header', async () => {
    for (const req of [request(generateApiKey()), request(''), request()]) {
      expect(await auth.authenticate(req)).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' })
    }
    expect(await auth.authenticate({ headers: { authorization: 'Bearer ' } } as IncomingMessage)).toMatchObject({ ok: false, status: 401 })
  })

  it('does not echo the presented key in the failure message', async () => {
    const bad = generateApiKey()
    const result = await auth.authenticate(request(bad))
    expect(JSON.stringify(result)).not.toContain(bad)
  })
})

describe('apiKeys config', () => {
  const base = { workspaces: '/data/workspaces', database: { url: 'postgres://agentry@db/agentry' } }
  const entry = entries[0]!
  const keycloak = { issuer: 'http://kc/realms/r', audience: 'agentry' }
  const config = (apiKeys: unknown) => () => Config({ ...base, auth: { mode: 'apiKeys', apiKeys } } as never)

  it('accepts valid entries', () => {
    expect(Config({ ...base, auth: { mode: 'apiKeys', apiKeys: entries } } as never).auth.apiKeys).toEqual(entries)
  })

  it('apiKeys config validation', () => {
    expect(config([])).toThrow(/apiKeys/)
    expect(() => Config({ ...base, auth: { mode: 'apiKeys' } } as never)).toThrow(/apiKeys/)
    expect(config([entry, { ...entries[1], name: 'a' }])).toThrow(/duplicate.*"a"/)
    expect(config([{ ...entry, hash: 'sha256:ABC' }])).toThrow(/hash/)
    expect(config([{ ...entry, hash: hashApiKey(keyA).toUpperCase() }])).toThrow(/hash/)
    expect(config([{ ...entry, hash: keyA }])).toThrow(/hash/)
    expect(config([{ ...entry, roles: [] }])).toThrow(/roles/)
    expect(config([{ ...entry, roles: ['root'] }])).toThrow(/roles.*root/)
    expect(config([{ ...entry, owner: '' }])).toThrow(/owner/)
    expect(config([{ ...entry, name: '' }])).toThrow(/name/)
  })

  it('apiKeys mode forbids devKey', () => {
    expect(() => Config({ ...base, auth: { mode: 'apiKeys', apiKeys: entries, devKey: { key: 'k', owner: 'dev' } } } as never)).toThrow(/devKey/)
  })

  it('production mode rejects apiKeys entries', () => {
    expect(() => Config({ ...base, auth: { mode: 'production', keycloak, apiKeys: entries } } as never)).toThrow(/apiKeys/)
  })

  it('development mode rejects apiKeys entries', () => {
    expect(() => Config({ ...base, auth: { mode: 'development', devKey: { key: 'k', owner: 'dev' }, apiKeys: entries } } as never)).toThrow(/apiKeys/)
  })

  it('apiKeys mode with keycloak accepts either credential', async () => {
    const resolved = Config({ ...base, auth: { mode: 'apiKeys', apiKeys: entries, keycloak } } as never)
    const warn = vi.fn()
    const auth = createAuthenticator(resolved.auth, warn)
    expect(await auth.authenticate(request(keyA))).toMatchObject({ ok: true, principal: { owner: 'ali' } })
    expect(await auth.authenticate(request('not-a-jwt'))).toMatchObject({ ok: false, status: 401 })
  })

  it('createAuthenticator serves api keys without keycloak', async () => {
    const resolved = Config({ ...base, auth: { mode: 'apiKeys', apiKeys: entries } } as never)
    const auth = createAuthenticator(resolved.auth, vi.fn())
    expect(await auth.authenticate(request(keyB))).toMatchObject({ ok: true, principal: { owner: 'bob' } })
  })
})

describe('keys:create', () => {
  const script = fileURLToPath(new URL('../scripts/keys-create.ts', import.meta.url))
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const exec = (...args: string[]) => run('node', ['--import', 'tsx/esm', script, ...args], { cwd })

  /** Parse `key: <key>` and the YAML entry from stdout. */
  function parse(stdout: string): { key: string; entry: Record<string, unknown> } {
    const key = /(agk_[A-Za-z0-9_-]{43})/.exec(stdout)?.[1]
    const name = /name: (\S+)/.exec(stdout)?.[1]
    const owner = /owner: (\S+)/.exec(stdout)?.[1]
    const hash = /hash: (\S+)/.exec(stdout)?.[1]
    const roles = /roles: \[(.*)\]/.exec(stdout)?.[1]?.split(',').map(r => r.trim())
    return { key: key!, entry: { name, owner, roles, hash } }
  }

  it('keys:create prints a key and a matching entry', async () => {
    const { stdout } = await exec('--name', 'ci', '--owner', 'ali')
    const { key, entry } = parse(stdout)
    expect(hashApiKey(key)).toBe(entry['hash'])
    expect(entry).toMatchObject({ name: 'ci', owner: 'ali', roles: ['agentry-user'] })
    expect(stdout.match(/agk_/g)).toHaveLength(1)
    expect(stdout).not.toContain(`hash: ${key}`)
  }, 30_000)

  it('--admin adds agentry-admin', async () => {
    const { stdout } = await exec('--name', 'root', '--owner', 'ali', '--admin')
    expect(parse(stdout).entry['roles']).toEqual(['agentry-user', 'agentry-admin'])
  }, 30_000)

  it('fails with usage on missing or unknown arguments', async () => {
    for (const args of [[], ['--name', 'ci'], ['--owner', 'ali'], ['--name', 'ci', '--owner', 'ali', '--bogus'], ['--name', '--owner', 'ali'], ['--name', 'ci', '--owner', 'ali', 'extra']]) {
      await expect(exec(...args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage:') })
    }
  }, 60_000)
})
