import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ownerId } from '../src/auth/authenticator.ts'
import { bridgeChildSessionEvent } from '../src/bridge.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import type { SandboxProvider } from '../src/sandbox/contract.ts'
import { SandboxRegistry } from '../src/sandbox/registry.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { openAuthenticator } from './open-auth.ts'
import { sanitizeRelativePath } from '../src/artifacts.ts'
import { resolveRuntimeConfig } from '../src/runtime-config.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { MemoryStore } from './support/memory-store.ts'
import { testGatewayOptions } from './support/fake-session-query.ts'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({
  Config: (input: Record<string, unknown>) => ({ ...input }),
  name: 'mcp-client',
}))

const servers: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function event(type: SessionEvent['type'], data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

function fakeContext(sandbox?: { create: ReturnType<typeof vi.fn> }): Context {
  const agents = new Map<string, { followup: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }>()
  const sessions = new Map<string, { id: string }>()
  return {
    get: (name: string) => name === 'dockerSandbox' ? sandbox : undefined,
    agents: {
      create: async ({ sessionId, setup }: { sessionId: string; setup?: (agentCtx: unknown) => Promise<void> }) => {
        const agent = { followup: vi.fn(), steer: vi.fn(), cancel: vi.fn() }
        agents.set(sessionId, agent)
        sessions.set(sessionId, { id: sessionId })
        if (setup) {
          await setup({
            get: () => ({ section: () => undefined }),
            systemPrompt: { section: () => undefined, getSectionOrder: () => 2500 },
            plugin: async () => undefined,
            tools: {
              register: () => () => undefined,
              restrict: () => () => undefined,
              guard: () => () => undefined,
            },
          })
        }
        return { agent, dispose: vi.fn(async () => undefined) }
      },
      get: (id: string) => agents.get(id),
    },
    sessions: { get: (id: string) => sessions.get(id) },
    tools: {
      schemas: () => [
        { name: 'web_search', description: 'Search', parameters: { type: 'object' } },
        { name: 'web_fetch', description: 'Fetch', parameters: { type: 'object' } },
      ],
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  } as unknown as Context
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<string> {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-api-'))
  dirs.push(dir)
  return dir
}

describe('local config', () => {
  it('resolves the configured workspaces root and ignores AGENTS_API_WORKSPACES', () => {
    expect(resolveRuntimeConfig({ workspaces: '/tmp/ws' }, { AGENTS_API_DATA_DIR: './data', AGENTS_API_WORKSPACES: '/elsewhere' })).toEqual({
      workspacesRoot: '/tmp/ws',
    })
  })

  it('fails loudly when workspaces is missing or blank', () => {
    expect(() => resolveRuntimeConfig({} as never, {})).toThrow(/"workspaces" is required/)
    expect(() => resolveRuntimeConfig({ workspaces: '  ' }, {})).toThrow(/"workspaces" is required/)
  })

  it('rejects the removed Codebox settings from the environment', () => {
    expect(() => resolveRuntimeConfig({ workspaces: '/tmp/ws' }, { CODEBOX_BASE_URL: 'http://codebox' })).toThrow(expect.objectContaining({ name: 'CodeboxRemovedError' }))
  })
})

describe('CoreAgent routes on the plugin gateway', () => {
  it('returns a local environment and attaches it to a session through the sandbox alias', async () => {
    const environments = createLocalProvider(await tempDir())
    const api = new AgentsGateway(fakeContext(), openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(environments))
    const root = await listen((req, res) => api.handle(req, res))
    const created = await fetch(`${root}/v1/agents/environments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(created.status).toBe(201)
    const env = await created.json() as { id: string; status: string; provider: string; provider_metadata: { workspace_directory?: string } }
    expect(env.provider).toBe('local')
    expect(env.status).toBe('connected')
    expect(env.provider_metadata.workspace_directory?.startsWith('/')).toBe(true)
    const session = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: { model: 'deepseek-chat' },
        environment: { type: 'sandbox', environment_id: env.id },
      }),
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ environment: { type: 'sandbox', environment_id: env.id } })
    const plain = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })
    const body = await plain.json() as { environment: { type: string; workspace_directory?: string } }
    expect(body.environment.type).toBe('local')
    expect(body.environment.workspace_directory?.startsWith('/')).toBe(true)
  })

  it('rejects sandbox attach even when dockerSandbox is present', async () => {
    const store = new MemoryStore()
    await store.ensureOwner(ownerId('test'))
    await store.environments.create(ownerId('test'), {
      id: 'env_box',
      object: 'environment',
      status: 'connected',
      provider: 'local',
      provider_metadata: {},
      created_at: 1,
    })
    const create = vi.fn(async () => undefined)
    const api = new AgentsGateway(fakeContext({ create }), openAuthenticator, '/v1', store, new SessionRegistry(), testGatewayOptions(createLocalProvider(await tempDir())))
    const root = await listen((req, res) => api.handle(req, res))
    const session = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: { model: 'deepseek-chat' },
        environment: { type: 'sandbox', environment_id: 'env_box' },
      }),
    })
    expect(session.status).toBe(400)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects artifact paths that escape the session workspace', async () => {
    const workspace = await tempDir()
    await writeFile(join(workspace, 'note.txt'), 'hello')
    const api = new AgentsGateway(fakeContext(), openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-surface-spec'))))
    const root = await listen((req, res) => api.handle(req, res))
    const session = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: { model: 'deepseek-chat' },
        environment: { type: 'local', workspace_directory: workspace },
      }),
    })
    const body = await session.json() as { id: string }
    const listed = await fetch(`${root}/v1/agents/sessions/${body.id}/artifacts`)
    expect(await listed.json()).toMatchObject({ object: 'list', data: [expect.objectContaining({ path: 'note.txt' })] })
    const escaped = await fetch(`${root}/v1/agents/sessions/${body.id}/artifacts/..%2Fsecret`)
    expect(escaped.status).toBe(400)
    expect(sanitizeRelativePath('../secret')).toBeUndefined()
  })

  it('keeps subagent turns and items off the parent list', async () => {
    const registry = new SessionRegistry()
    const api = new AgentsGateway(fakeContext(), openAuthenticator, '/v1', new MemoryStore(), registry, testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-surface-spec'))))
    const root = await listen((req, res) => api.handle(req, res))
    const session = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })
    const body = await session.json() as { id: string }
    bridgeChildSessionEvent(body.id, 'child_1', event('turn/start', { turn: 1 }), registry)
    bridgeChildSessionEvent(body.id, 'child_1', event('user/message', {
      content: [{ type: 'text', text: 'child' }],
      source: { kind: 'user' },
    }, 2), registry)
    bridgeChildSessionEvent(body.id, 'child_1', event('turn/end', {}), registry)
    const parentItems = await fetch(`${root}/v1/agents/sessions/${body.id}/items`)
    expect((await parentItems.json() as { data: unknown[] }).data).toEqual([])
    const children = await fetch(`${root}/v1/agents/sessions/${body.id}/subagents`)
    const listed = await children.json() as { data: Array<{ id: string; status: string }> }
    expect(listed.data.map(row => row.id)).toEqual(['child_1'])
    const items = await fetch(`${root}/v1/agents/sessions/${body.id}/subagents/child_1/items`)
    const childItems = await items.json() as { data: Array<{ subagent_id?: string }> }
    expect(childItems.data[0]?.subagent_id).toBe('child_1')
    const turns = await fetch(`${root}/v1/agents/sessions/${body.id}/subagents/child_1/turns`)
    const childTurns = await turns.json() as { data: Array<{ subagent_id?: string; status: string }> }
    expect(childTurns.data[0]).toMatchObject({ subagent_id: 'child_1', status: 'completed' })
  })

  it('numbers the created event 1 on a streamed create', async () => {
    const api = new AgentsGateway(fakeContext(), openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-surface-spec'))))
    const root = await listen((req, res) => api.handle(req, res))
    const created = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })
    const reader = created.body?.getReader()
    const first = new TextDecoder().decode((await reader?.read())?.value)
    await reader?.cancel()
    expect(first).toMatch(/^id: 1\nevent: agent\.session\.created\n/u)
  })

  it('masks the tool catalog only when session_id is set', async () => {
    const api = new AgentsGateway(fakeContext(), openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-surface-spec'))))
    const root = await listen((req, res) => api.handle(req, res))
    const full = await fetch(`${root}/v1/agents/tools`)
    expect((await full.json() as { data: Array<{ name: string }> }).data.map(row => row.name)).toEqual(['web_search', 'web_fetch'])
    const session = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: { model: 'deepseek-chat', host_tools: { allow: ['web_fetch'] } },
      }),
    })
    const body = await session.json() as { id: string }
    const masked = await fetch(`${root}/v1/agents/tools?session_id=${body.id}`)
    expect((await masked.json() as { data: Array<{ name: string }> }).data.map(row => row.name)).toEqual(['web_fetch'])
  })
})

describe('sessions on hosted environments', () => {
  async function harness(extraProviders: SandboxProvider[] = []) {
    const store = new MemoryStore()
    const registry = new SandboxRegistry('local')
    registry.register(createLocalProvider(await tempDir()))
    for (const provider of extraProviders) registry.register(provider)
    const api = new AgentsGateway(fakeContext(), openAuthenticator, '/v1', store, new SessionRegistry(), testGatewayOptions(registry))
    const root = await listen((req, res) => api.handle(req, res))
    const post = (path: string, body: unknown) => fetch(`${root}/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const session = (environment: unknown) => post('/agents/sessions', { agent: { model: 'deepseek-chat' }, environment })
    return { store, root, post, session }
  }

  const noExec: SandboxProvider = {
    kind: 'files-only',
    capabilities: { templateFields: ['files'], files: true, exec: false },
    async create() { return { status: 'connected', workspacePath: '/workspace', handle: { box: 'b1' } } },
    async status() { return 'connected' },
    async destroy() {},
    async listFiles() { return [] },
    async readFile() { return new Uint8Array() },
    async writeFile() {},
  }

  it('provisions an environment from a template or inline fields and uses its directory as the session cwd', async () => {
    const { post, session, root } = await harness()
    const template = await (await post('/agents/environments/templates', { files: [{ type: 'inline', path: '/workspace/seed.txt', data: Buffer.from('s').toString('base64') }] })).json() as { id: string }
    const viaTemplate = await session({ type: 'openai_hosted', environment_template_id: template.id })
    expect(viaTemplate.status).toBe(200)
    const body = await viaTemplate.json() as { environment: { type: string; environment_id: string } }
    expect(body.environment).toMatchObject({ type: 'sandbox' })
    const env = await (await fetch(`${root}/v1/agents/environments/${body.environment.environment_id}`)).json() as { files: Array<{ path: string }>; session_id: string }
    expect(env.files.map(f => f.path)).toEqual(['/workspace/seed.txt'])
    const inline = await session({ type: 'openai_hosted', files: [{ type: 'inline', path: '/workspace/x.txt', data: 'eA==' }] })
    expect(inline.status).toBe(200)
  })

  it('keeps a bare openai_hosted environment working, and attaches an existing environment through the sandbox alias', async () => {
    const { post, session } = await harness()
    expect((await session({ type: 'openai_hosted' })).status).toBe(200)
    const env = await (await post('/agents/environments', {})).json() as { id: string }
    const attached = await session({ type: 'sandbox', environment_id: env.id })
    expect(attached.status).toBe(200)
    expect(await attached.json()).toMatchObject({ environment: { type: 'sandbox', environment_id: env.id } })
    const missing = await session({ type: 'sandbox', environment_id: 'env_missing' })
    expect(missing.status).toBe(404)
  })

  it('refuses a provider that cannot run commands, a template it cannot apply, and an unknown provider, with specific codes', async () => {
    const { post, session } = await harness([noExec])
    const t = await (await post('/agents/environments/templates', { provider: 'files-only' })).json() as { id: string }
    const noRun = await session({ type: 'openai_hosted', environment_template_id: t.id })
    expect(noRun.status).toBe(400)
    expect(await noRun.json()).toMatchObject({ error: { code: 'sandbox_exec_unavailable', message: expect.stringContaining('files-only') } })
    const restricted = await session({ type: 'openai_hosted', network: { access: 'disabled' } })
    expect(restricted.status).toBe(400)
    expect(await restricted.json()).toMatchObject({ error: { code: 'sandbox_template_unsupported', message: expect.stringContaining('network') } })
    const unknown = await session({ type: 'openai_hosted', provider: 'nope', files: [] })
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(await unknown.json())).toContain('unknown sandbox provider')
  })
})

describe('environment templates in the OpenAI Agents API shape', () => {
  async function harness() {
    const store = new MemoryStore()
    const api = new AgentsGateway(fakeContext(), openAuthenticator, '/v1', store, new SessionRegistry(), testGatewayOptions(createLocalProvider(await tempDir())))
    const root = await listen((req, res) => api.handle(req, res))
    const post = (path: string, body: unknown) => fetch(`${root}/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { store, root, post }
  }

  it('creates a template from the SDK params: SDK object, no confidential data, unsupported fields listed', async () => {
    const { post, root } = await harness()
    const res = await post('/agents/environments/templates', {
      name: 'ci',
      env: { SECRET: 'x' },
      network: { access: 'disabled' },
      skills: [{ type: 'skill_reference', skill_id: 'skill_1' }],
      files: [{ type: 'inline', path: '/workspace/a.txt', data: Buffer.from('hi').toString('base64') }],
      setup_commands: [{ command: 'make' }],
    })
    expect(res.status).toBe(201)
    const text = await res.text()
    const body = JSON.parse(text) as Record<string, unknown>
    expect(body).toMatchObject({
      object: 'agent.environment.template',
      name: 'ci',
      provider: 'local',
      network: { access: 'disabled', allowed_domains: [] },
      packages: { npm: [], python: [], system: [] },
      files: [{ type: 'inline', path: '/workspace/a.txt', size_bytes: 2 }],
      skills: [{ type: 'skill_reference', skill_id: 'skill_1' }],
      unsupported_fields: ['env', 'network', 'skills', 'setup_commands'],
    })
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('"make"')
    const list = await (await fetch(`${root}/v1/agents/environments/templates`)).json() as { data: Array<{ object: string }> }
    expect(list.data.map(t => t.object)).toEqual(['agent.environment.template'])
    const deleted = await fetch(`${root}/v1/agents/environments/templates/${String(body['id'])}`, { method: 'DELETE' })
    expect(await deleted.json()).toMatchObject({ object: 'agent.environment.template.deleted', deleted: true })
  })

  it('still accepts the earlier nested body, rejects an unknown provider, and updates by replacing the given fields', async () => {
    const { post } = await harness()
    const created = await post('/agents/environments/templates', { name: 'old', config: { image: 'base', starter_files: [{ path: 'a.txt', content: 'x' }] } })
    expect(created.status).toBe(201)
    const body = await created.json() as { id: string; files: unknown[]; image?: string }
    expect(body.files).toEqual([{ type: 'inline', path: '/workspace/a.txt', size_bytes: 1 }])
    expect(body.image).toBe('base')
    const bad = await post('/agents/environments/templates', { name: 'x', provider: 'nope' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe('unknown sandbox provider "nope"; available: local')
    const updated = await post(`/agents/environments/templates/${body.id}`, { name: 'renamed', network: { access: 'enabled' } })
    expect(await updated.json()).toMatchObject({ name: 'renamed', image: 'base', files: [{ path: '/workspace/a.txt' }], unsupported_fields: ['image'] })
  })

  it('reads a template stored in the Codebox-era layout under an unregistered provider', async () => {
    const { store, root } = await harness()
    await store.ensureOwner(ownerId('test'))
    await store.templates.create(ownerId('test'), { id: 'tpl_old', object: 'environment.template', name: 'legacy', provider: 'codebox', config: { image: 'base', setup: 'make', packages: ['git'] }, created_at: 5 })
    const res = await fetch(`${root}/v1/agents/environments/templates/tpl_old`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      object: 'agent.environment.template',
      provider: 'codebox',
      packages: { system: ['git'] },
      unsupported_fields: ['packages', 'setup_commands', 'image'],
    })
  })

  it('provisions an environment from a supported template and refuses an unsupported one', async () => {
    const { post, root } = await harness()
    const ok = await (await post('/agents/environments/templates', { files: [{ type: 'inline', path: '/workspace/notes/a.txt', data: Buffer.from('hi').toString('base64') }] })).json() as { id: string }
    const created = await post('/agents/environments', { template_id: ok.id })
    expect(created.status).toBe(201)
    const env = await created.json() as { id: string }
    const files = await (await fetch(`${root}/v1/agents/environments/${env.id}/files`)).json() as { data: Array<{ path: string; size_bytes: number }> }
    expect(files.data).toMatchObject([{ object: 'agent.environment.file', environment_id: env.id, path: '/workspace/notes/a.txt', size_bytes: 2 }])
    const asEnv = await (await fetch(`${root}/v1/agents/environments/${env.id}`)).json() as Record<string, unknown>
    expect(asEnv).toMatchObject({ object: 'agent.environment', type: 'self_hosted', status: 'connected', files: [{ type: 'inline', path: '/workspace/notes/a.txt', size_bytes: 2 }], skills: [], plugins: [] })
    const restricted = await (await post('/agents/environments/templates', { network: { access: 'restricted', allowed_domains: ['example.com'] } })).json() as { id: string }
    const refused = await post('/agents/environments', { template_id: restricted.id })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'sandbox_template_unsupported', message: expect.stringContaining('network') } })
  })
})
