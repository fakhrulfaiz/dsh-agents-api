import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startTestService, type TestService } from '@agentry/sandbox/testing'
import { ownerId } from '../src/auth/authenticator.ts'
import { toSdkEnvironment } from '../src/environment/environment-compat.ts'
import type { EnvironmentRecord, EnvironmentTemplateConfig } from '../src/environment-types.ts'
import { inlineTemplate, mountSandboxTools, SANDBOX_TOOL_NAMES } from '../src/mount-sandbox-tools.ts'
import { createAgentrySandboxProvider } from '../src/sandbox/agentry-sandbox-provider.ts'
import { MemoryStore } from './support/memory-store.ts'

const OWNER = ownerId('owner-a')
let svc: TestService
let store: MemoryStore
let tools: Map<string, { execute(args: unknown): Promise<string> }>
let approve: (exec: { name: string; arguments: unknown }, next: () => Promise<unknown>) => Promise<unknown>
let n = 0

let workspace: string
async function setup(env: Record<string, string> = {}, current?: string) {
  svc = await startTestService(env)
  store = new MemoryStore()
  await store.ensureOwner(OWNER)
  const root = await mkdtemp(join(tmpdir(), 'agentry-sbx-tools-'))
  workspace = await mkdtemp(join(tmpdir(), 'agentry-chat-ws-'))
  const provider = createAgentrySandboxProvider({ url: svc.url, key: svc.key, workspacesRoot: root })
  tools = new Map()
  const ctx = {
    tools: { register: (d: { name: string; execute(args: unknown): Promise<string> }) => { tools.set(d.name, d); return () => {} } },
    on: (_event: string, fn: typeof approve) => { approve = fn },
  }
  mountSandboxTools(ctx as never, {
    owner: OWNER,
    store,
    provider,
    cwd: workspace,
    async provision(raw, inline?: EnvironmentTemplateConfig) {
      const id = `env_t${String(++n)}`
      const created = await provider.create(OWNER, id, { ...(raw['name'] ? { name: String(raw['name']) } : {}), ...(inline ? { template: inline } : {}) })
      const record: EnvironmentRecord = { id, object: 'environment', status: created.status, provider: 'sandbox', provider_metadata: { ...created.handle, ...(raw['name'] ? { name: String(raw['name']) } : {}) }, created_at: 1, ...(created.error ? { error: created.error } : {}) } as EnvironmentRecord
      await store.environments.create(OWNER, record)
      return { ...toSdkEnvironment(record), sandbox: await provider.describe(record), ...(raw['name'] ? { name: String(raw['name']) } : {}) }
    },
    destroy: (record) => provider.destroy(record),
    describe: async (record) => ({ ...toSdkEnvironment(record), ...(record.provider_metadata['name'] ? { name: record.provider_metadata['name'] } : {}), sandbox: await provider.describe(record) }),
    ...(current ? { currentEnvironmentId: current } : {}),
  })
}
const call = async (name: string, args: unknown = {}) => JSON.parse(await tools.get(name)!.execute(args)) as Record<string, unknown>
afterEach(async () => { await svc?.close() })

describe('sandbox tools', () => {
  beforeEach(async () => { await setup() })

  it('registers the nine tools', () => {
    expect([...tools.keys()].sort()).toEqual([...SANDBOX_TOOL_NAMES].sort())
  })

  it('copies a file out of a sandbox into the chat workspace and back in, refusing escapes', async () => {
    const files = new Map<string, string>([['/home/agent/demo/a.txt', 'hello']])
    const envd = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname === '/files' && req.method === 'GET') {
          const v = files.get(path)
          return void (v === undefined ? res.writeHead(404).end('{}') : res.end(v))
        }
        if (url.pathname === '/files' && req.method === 'POST') {
          files.set(path, Buffer.concat(chunks).toString('latin1').split('\r\n\r\n')[1]?.split('\r\n--')[0] ?? '')
          return void res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
        }
        res.writeHead(404).end('{}')
      })
    })
    await new Promise<void>((r) => envd.listen(0, '127.0.0.1', r))
    svc.backend.setEndpoint(`http://127.0.0.1:${String((envd.address() as AddressInfo).port)}`)
    try {
      const id = String((await call('sandbox_create', { name: 'Copy test' }))['id'])
      expect(await call('sandbox_pull', { id, from: '~/demo/a.txt', to: 'out/a.txt' })).toMatchObject({ copied: 'out/a.txt', bytes: 5 })
      expect(await readFile(join(workspace, 'out/a.txt'), 'utf8')).toBe('hello')
      expect(await call('sandbox_pull', { id, from: '~/demo/a.txt', to: '../escape.txt' })).toHaveProperty('error')
      await writeFile(join(workspace, 'b.txt'), 'back')
      expect(await call('sandbox_push', { id, from: 'b.txt', to: '~/b.txt' })).toMatchObject({ bytes: 4 })
      expect(files.get('/home/agent/b.txt')).toBe('back')
      expect(await call('sandbox_push', { id, from: '../x' })).toHaveProperty('error')
    } finally {
      envd.closeAllConnections()
      await new Promise<void>((r) => envd.close(() => r()))
    }
  })

  it('creates, lists, stops, starts and deletes a sandbox for the owner', async () => {
    const created = await call('sandbox_create', { name: 'Scraper test', python_packages: ['requests'], internet: false })
    expect(created).toMatchObject({ name: 'Scraper test', state: 'running' })
    const sbx = (await svc.service.list('owner-a'))[0]!
    expect(sbx.template).toMatchObject({ network: false, setupCommands: [expect.stringContaining('--break-system-packages')] })
    expect((await call('sandbox_list')).sandboxes).toEqual([expect.objectContaining({ id: created.id, name: 'Scraper test', state: 'running' })])
    expect(await call('sandbox_stop', { id: created.id })).toMatchObject({ state: 'stopped' })
    expect(await call('sandbox_start', { id: created.id })).toMatchObject({ state: 'running' })
    expect(await call('sandbox_delete', { id: created.id })).toEqual({ id: created.id, deleted: true })
    expect(await svc.service.list('owner-a')).toEqual([])
    expect((await call('sandbox_list')).sandboxes).toEqual([])
  })

  it('asks before create and delete only', async () => {
    const next = async () => 'ran'
    expect(await approve({ name: 'sandbox_create', arguments: { name: 'Box', image: 'python:3.13', python_packages: ['polars'], internet: false } }, next))
      .toMatchObject({ kind: 'ask', reason: 'Create sandbox "Box" (image python:3.13, polars, no internet)' })
    expect(await approve({ name: 'sandbox_delete', arguments: { id: 'env_x' } }, next)).toMatchObject({ kind: 'ask', reason: expect.stringContaining('Delete sandbox') })
    for (const name of ['sandbox_list', 'sandbox_exec', 'sandbox_start', 'sandbox_stop', 'agent_list']) expect(await approve({ name, arguments: {} }, next)).toBe('ran')
  })

  it('refuses unknown ids and environments that are not isolated sandboxes', async () => {
    expect(await call('sandbox_exec', { id: 'env_nope', command: 'ls' })).toMatchObject({ error: expect.stringContaining('sandbox_list') })
    await store.environments.create(OWNER, { id: 'env_local', object: 'environment', status: 'connected', provider: 'local', provider_metadata: { workspace_directory: '/tmp/x' }, created_at: 1 } as EnvironmentRecord)
    expect(await call('sandbox_start', { id: 'env_local' })).toMatchObject({ error: expect.stringContaining('runs on this server') })
  })

  it('a sandbox that failed to set up says why and can still be deleted', async () => {
    svc.backend.failNextCreate('setup command "pip install x" failed (exit 1)')
    const failed = await call('sandbox_create', { name: 'Broken' })
    expect(failed).toMatchObject({ error: expect.stringContaining('exit 1') })
    expect(await call('sandbox_exec', { id: failed.id, command: 'ls' })).toMatchObject({ error: expect.stringContaining('failed to set up') })
    expect(await call('sandbox_delete', { id: failed.id })).toEqual({ id: failed.id, deleted: true })
    expect(await svc.service.list('owner-a')).toEqual([])
  })

  it('passes the service limits back as the tool error', async () => {
    await svc.close()
    await setup({ AGENTRY_SANDBOX_MAX_PER_OWNER: '1' })
    await call('sandbox_create', { name: 'one' })
    expect(await call('sandbox_create', { name: 'two' })).toMatchObject({ error: expect.stringContaining('limit 1') })
  })
})

describe('sandbox tools in a sandbox chat', () => {
  it('never stops or deletes the sandbox the chat runs in', async () => {
    await setup({}, 'env_t_current')
    await store.environments.create(OWNER, { id: 'env_t_current', object: 'environment', status: 'connected', provider: 'sandbox', provider_metadata: { sandbox_id: 'sbx_x', workspace_directory: '/w', owner: 'owner-a' }, created_at: 1 } as EnvironmentRecord)
    expect(await call('sandbox_delete', { id: 'env_t_current' })).toMatchObject({ error: expect.stringContaining('this chat runs in') })
    expect(await call('sandbox_stop', { id: 'env_t_current' })).toMatchObject({ error: expect.stringContaining('this chat runs in') })
  })
})

describe('inline sandbox setup', () => {
  it('maps the create arguments to template config', () => {
    expect(inlineTemplate({ name: 'x' })).toBeUndefined()
    expect(inlineTemplate({ image: 'python:3.13', system_packages: ['jq'], setup_commands: ['echo hi'], internet: true })).toEqual({ image: 'python:3.13', packages: { python: [], system: ['jq'], npm: [] }, setup_commands: [{ command: 'echo hi' }] })
  })
})
