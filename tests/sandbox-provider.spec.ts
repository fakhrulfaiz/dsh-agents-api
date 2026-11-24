import { mkdtemp, stat } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startTestService, type TestService } from '@agentry/sandbox/testing'
import type { OwnerId } from '../src/auth/authenticator.ts'
import { copyIntoSandboxUploads, createAgentrySandboxProvider } from '../src/sandbox/agentry-sandbox-provider.ts'
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
        const { path, depth } = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { path: string; depth?: number }
        const below = [...files.keys()].filter((p) => p.startsWith(`${path}/`))
        const seen = new Map<string, { name: string; type: string; path: string; size: string; modifiedTime: string }>()
        for (const p of below) {
          const parts = p.slice(path.length + 1).split('/')
          if (depth === 1 && parts.length > 1) {
            const dir = `${path}/${parts[0]!}`
            seen.set(dir, { name: parts[0]!, type: 'FILE_TYPE_DIRECTORY', path: dir, size: '0', modifiedTime: '2026-11-24T00:00:00Z' })
          } else {
            seen.set(p, { name: p.split('/').pop()!, type: 'FILE_TYPE_FILE', path: p, size: String(files.get(p)!.length), modifiedTime: '2026-11-24T01:02:03Z' })
          }
        }
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ entries: [...seen.values()] }))
      }
      if (url.pathname === '/filesystem.Filesystem/Stat') {
        const { path } = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { path: string }
        if (!files.has(path)) return void res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'not_found', message: 'no such file' }))
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ entry: { name: path.split('/').pop(), type: 'FILE_TYPE_FILE', path, size: String(files.get(path)!.length) } }))
      }
      if (url.pathname === '/filesystem.Filesystem/Remove') {
        const { path } = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { path: string }
        files.delete(path)
        return void res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
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
  it('maps template files: base64 inline data decoded, /workspace paths into the real workspace, file_id skipped', async () => {
    const { toServiceTemplate } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    const out = toServiceTemplate({ files: [
      { type: 'inline', path: '/workspace/notes/a.md', data: Buffer.from('# hi').toString('base64') },
      { type: 'inline', path: 'b.txt', data: Buffer.from('b').toString('base64') },
      { type: 'file_id', path: '/workspace/c.bin', file_id: 'file_1' },
    ] })
    expect(out.files).toEqual([{ path: 'notes/a.md', content: '# hi' }, { path: 'b.txt', content: 'b' }])
  })

  it('passes resources through and reports the default image', async () => {
    const { toServiceTemplate } = await import('../src/sandbox/agentry-sandbox-provider.ts')
    expect(toServiceTemplate({ resources: { cpus: 2, memory_mb: 4096 } }).resources).toEqual({ cpus: 2, memory_mb: 4096 })
    expect(await provider().availability()).toMatchObject({ available: true, default_image: { name: expect.any(String), runtimes: { python: '3.11' } } })
  })

  it('describes a sandbox, and says gone once it is deleted', async () => {
    const p = provider()
    const created = await p.create(OWNER, 'env_1', { name: 'Data box' })
    const r = record(created.handle!)
    expect(await p.describe(r)).toMatchObject({ state: 'running', image: expect.any(String) })
    expect((await svc.service.get('owner-a', created.handle!.sandbox_id!)).name).toBe('Data box')
    await p.destroy(r)
    expect(await p.describe(r)).toMatchObject({ state: 'gone' })
  })

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

  it('lists workspace entries with size and time (skipping .git and node_modules), stats, removes, and copies uploads without overwriting', async () => {
    const p = provider()
    const created = await p.create(OWNER, 'env_1', {})
    const r = record(created.handle!)
    const w = created.workspacePath
    files.set(`${w}/report.md`, '# hi')
    files.set(`${w}/out/chart.png`, 'png!')
    files.set(`${w}/node_modules/x/index.js`, 'x')
    files.set(`${w}/.git/HEAD`, 'ref')
    expect(await p.listEntries(r)).toEqual([
      { path: 'out/chart.png', size: 4, last_modified: '2026-11-24T01:02:03.000Z' },
      { path: 'report.md', size: 4, last_modified: '2026-11-24T01:02:03.000Z' },
    ])
    expect(await p.exists(r, 'report.md')).toBe(true)
    expect(await p.exists(r, 'nope.md')).toBe(false)
    const first = await copyIntoSandboxUploads(p, r, 'data.csv', (async function* () { yield new TextEncoder().encode('a,b') })())
    const second = await copyIntoSandboxUploads(p, r, 'data.csv', (async function* () { yield new TextEncoder().encode('c,d') })())
    expect([first.relative, second.relative]).toEqual(['uploads/data.csv', 'uploads/data-1.csv'])
    expect(files.get(`${w}/uploads/data.csv`)).toBe('a,b')
    expect(second.absolute).toBe(`${w}/uploads/data-1.csv`)
    await second.remove?.()
    expect(files.has(`${w}/uploads/data-1.csv`)).toBe(false)
  })

  it('a failed create reports failed with the reason; status of a missing sandbox is failed', async () => {
    const p = provider()
    svc.backend.failNextCreate('setup command "exit 3" failed')
    const created = await p.create(OWNER, 'env_2', {})
    expect(created).toMatchObject({ status: 'failed', error: expect.stringContaining('exit 3') })
    expect(await p.status(record({ sandbox_id: 'sbx_missing', workspace_directory: '/x' }))).toBe('failed')
  })

  it('reports availability, with the reason when the service is unreachable or refuses the key', async () => {
    expect(await provider().availability()).toMatchObject({ available: true, version: 'fake' })
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
