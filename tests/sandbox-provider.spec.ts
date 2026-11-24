import { mkdtemp, stat } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startTestService, type TestService } from '@agentry/sandbox/testing'
import type { OwnerId } from '../src/auth/authenticator.ts'
import { createAgentrySandboxProvider } from '../src/sandbox/agentry-sandbox-provider.ts'
import type { EnvironmentRecord } from '../src/environment-types.ts'

const OWNER = 'owner-a' as OwnerId
let svc: TestService
let envd: http.Server
let files: Map<string, string>
let root: string

beforeEach(async () => {
  svc = await startTestService()
  root = await mkdtemp(join(tmpdir(), 'agentry-sbx-'))
  files = new Map()
  // A tiny envd: /files read and write, and filesystem.ListDir.
  envd = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (url.pathname === '/files' && req.method === 'GET') {
        const v = files.get(url.searchParams.get('path') ?? '')
        if (v === undefined) return void res.writeHead(404).end('{}')
        return void res.end(v)
      }
      if (url.pathname === '/files' && req.method === 'POST') {
        const body = Buffer.concat(chunks).toString('latin1')
        const content = body.split('\r\n\r\n')[1]?.split('\r\n--')[0] ?? ''
        files.set(url.searchParams.get('path') ?? '', content)
        return void res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
      }
      if (url.pathname === '/filesystem.Filesystem/ListDir') {
        const { path } = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { path: string }
        const entries = [...files.keys()].filter((p) => p.startsWith(`${path}/`)).map((p) => ({ name: p.split('/').pop(), type: 'FILE_TYPE_FILE', path: p }))
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ entries }))
      }
      res.writeHead(404).end('{}')
    })
  })
  await new Promise<void>((r) => envd.listen(0, '127.0.0.1', r))
  svc.backend.setEndpoint(`http://127.0.0.1:${String((envd.address() as AddressInfo).port)}`)
})
afterEach(async () => {
  await svc.close()
  envd.closeAllConnections()
  await new Promise<void>((r) => envd.close(() => r()))
})

const provider = () => createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: root })
const record = (handle: Record<string, string>): EnvironmentRecord => ({ id: 'env_1', object: 'environment', status: 'connected', provider: 'sandbox', provider_metadata: handle, created_at: 1 }) as EnvironmentRecord

describe('sandbox environment provider', () => {
  it('creates a sandbox mounted at a host placeholder path, reports status and destroys it', async () => {
    const p = provider()
    const created = await p.create(OWNER, 'env_1', { template: { image: 'python:3.13', packages: { system: ['jq'], python: ['rich'] }, setup_commands: [{ command: 'echo hi' }], network: { access: 'disabled' } } })
    expect(created.status).toBe('connected')
    expect(created.workspacePath).toBe(join(root, 'owner-a', 'sandbox-env_1'))
    expect((await stat(created.workspacePath)).isDirectory()).toBe(true)
    expect(created.handle).toMatchObject({ workspace_directory: created.workspacePath, sandbox_id: expect.stringMatching(/^sbx_/), image: 'python:3.13' })
    const sbx = await svc.service.get('owner-a', created.handle!.sandbox_id!)
    expect(sbx.template).toMatchObject({ image: 'python:3.13', packages: ['jq'], network: false, workspacePath: created.workspacePath, setupCommands: ['echo hi', 'pip install --user rich'] })
    expect(await p.status(record(created.handle!))).toBe('connected')
    await p.destroy(record(created.handle!))
    await expect(svc.service.get('owner-a', created.handle!.sandbox_id!)).rejects.toThrow()
  })

  it('reads, writes and lists workspace files through the sandbox', async () => {
    const p = provider()
    const created = await p.create(OWNER, 'env_1', {})
    const r = record(created.handle!)
    await p.writeFile(r, 'notes/a.txt', new TextEncoder().encode('hello'))
    expect([...files.entries()]).toEqual([[`${created.workspacePath}/notes/a.txt`, 'hello']])
    expect(new TextDecoder().decode(await p.readFile(r, 'notes/a.txt'))).toBe('hello')
    expect(await p.listFiles(r)).toEqual(['notes/a.txt'])
    await expect(p.readFile(r, '../../etc/passwd')).rejects.toThrow(/invalid workspace path/)
  })

  it('a failed create reports failed with the reason; status of a missing sandbox is failed', async () => {
    const p = provider()
    svc.backend.failNextCreate('setup command "exit 3" failed')
    const created = await p.create(OWNER, 'env_2', {})
    expect(created).toMatchObject({ status: 'failed', error: expect.stringContaining('exit 3') })
    expect(await p.status(record({ sandbox_id: 'sbx_missing', workspace_directory: '/x' }))).toBe('failed')
  })

  it('reports availability, with the reason when the service is unreachable or refuses the key', async () => {
    expect(await provider().availability()).toEqual({ available: true, version: 'fake' })
    expect(await createAgentrySandboxProvider({ url: 'http://127.0.0.1:1', key: 'k', workspacesRoot: root }).availability()).toMatchObject({ available: false, reason: expect.stringContaining('not reachable') })
    expect(await createAgentrySandboxProvider({ url: svc.url, key: 'wrong', workspacesRoot: root }).availability()).toMatchObject({ available: false, reason: expect.stringContaining('key') })
  })

  it('passes quota refusals through with their message', async () => {
    await svc.close()
    svc = await startTestService({ AGENTRY_SANDBOX_MAX_PER_OWNER: '1' })
    const p = createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: root })
    expect((await p.create(OWNER, 'env_a', {})).status).toBe('connected')
    expect(await p.create(OWNER, 'env_b', {})).toMatchObject({ status: 'failed', error: expect.stringContaining('limit 1') })
  })
})
