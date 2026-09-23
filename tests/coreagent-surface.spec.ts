import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentStore } from '../src/agent-store.ts'
import { bridgeChildSessionEvent } from '../src/bridge.ts'
import { FsAgentsApiStore, FsEnvironmentApiStore } from '../src/durable-store.ts'
import { EnvironmentDirectory } from '../src/environment-service.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { sanitizeRelativePath } from '../src/artifacts.ts'
import { resolveRuntimeConfig } from '../src/runtime-config.ts'
import { SessionRegistry } from '../src/session-registry.ts'

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
            systemPrompt: { section: () => undefined },
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

describe('durable stores and local config', () => {
  it('reloads saved agents and environment rows from dataDir', async () => {
    const dataDir = await tempDir()
    const agents = new FsAgentsApiStore(dataDir)
    const envs = new FsEnvironmentApiStore(dataDir)
    const first = new AgentStore()
    await agents.open()
    first.bindPersistence({
      put: agent => agents.putAgent(agent),
      remove: async (id) => {
        await agents.deleteAgent(id)
      },
    })
    const saved = first.create({ model: 'deepseek-chat', name: 'kept' })
    await first.settled()
    const environments = new EnvironmentDirectory()
    const template = environments.createTemplate({ name: 'base', config: { image: 'base' } })
    await environments.openDisk(envs)
    environments.templates.set(template.id, template)
    await envs.putTemplate(template)
    const second = new AgentStore()
    second.load(await agents.loadAll())
    const reloadedEnv = new EnvironmentDirectory()
    await reloadedEnv.openDisk(envs)
    expect(second.get(saved.id)?.name).toBe('kept')
    expect(reloadedEnv.templates.get(template.id)?.name).toBe('base')
    expect(await readFile(join(dataDir, 'SCHEMA_VERSION'), 'utf8')).toBe('1\n')
  })

  it('stays off when dataDir, Codebox, and S3 are unset', () => {
    expect(resolveRuntimeConfig({}, {})).toEqual({})
    expect(resolveRuntimeConfig({}, { AGENTS_API_DATA_DIR: './data', AGENTS_API_WORKSPACES: '/tmp/ws' })).toEqual({
      dataDir: './data',
      workspacesRoot: '/tmp/ws',
    })
  })
})

describe('CoreAgent routes on the plugin gateway', () => {
  it('returns a local environment when Codebox is unset and rejects sandbox sessions', async () => {
    const environments = new EnvironmentDirectory()
    const api = new AgentsGateway(fakeContext(), '', '/v1', new AgentStore(), new SessionRegistry(), { environments })
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
    expect(session.status).toBe(400)
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
    const environments = new EnvironmentDirectory()
    environments.environments.set('env_box', {
      id: 'env_box',
      object: 'environment',
      status: 'connected',
      provider: 'codebox',
      provider_metadata: { codebox_id: 'box_1' },
      created_at: 1,
    })
    const create = vi.fn(async () => undefined)
    const api = new AgentsGateway(fakeContext({ create }), '', '/v1', new AgentStore(), new SessionRegistry(), { environments })
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
    const api = new AgentsGateway(fakeContext(), '', '/v1', new AgentStore(), new SessionRegistry())
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
    const api = new AgentsGateway(fakeContext(), '', '/v1', new AgentStore(), registry)
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

  it('replays SSE events after Last-Event-ID', async () => {
    const registry = new SessionRegistry()
    const api = new AgentsGateway(fakeContext(), '', '/v1', new AgentStore(), registry)
    const root = await listen((req, res) => api.handle(req, res))
    const created = await fetch(`${root}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    })
    const reader = created.body?.getReader()
    const first = new TextDecoder().decode((await reader?.read())?.value)
    await reader?.cancel()
    const sessionId = /"id":"(sess_[^"]+)"/u.exec(first)?.[1]
    expect(first).toContain('id: 1')
    expect(sessionId).toBeTruthy()
    const resume = await fetch(`${root}/v1/agents/sessions/${sessionId ?? ''}/events`, {
      headers: { 'Last-Event-ID': '1' },
    })
    const resumeReader = resume.body?.getReader()
    const resumed = new TextDecoder().decode((await resumeReader?.read())?.value)
    await resumeReader?.cancel()
    expect(resumed).toContain('id: 2')
    expect(resumed.includes('id: 1\n')).toBe(false)
  })

  it('masks the tool catalog only when session_id is set', async () => {
    const api = new AgentsGateway(fakeContext(), '', '/v1', new AgentStore(), new SessionRegistry())
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
