/**
 * `/v1/agents/projects`: owner scoping, defaults and validation, archive, and the delete gate.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId, type Authenticator } from '../src/auth/authenticator.ts'
import { materializeAgent } from '../src/agent-records.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { fakeLlm, fakeModel } from './support/fake-model.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'

const ALICE = ownerId('alice')
const environments = createLocalProvider(join(tmpdir(), 'agentry-projects-spec'))
const servers: Server[] = []

/** Authenticates every request as the owner named by `x-owner`. */
const ownerHeader: Authenticator = {
  authenticate: req => Promise.resolve({
    ok: true as const,
    principal: { owner: ownerId(String(req.headers['x-owner'] ?? 'alice')), roles: new Set(['agentry-user' as const]) },
  }),
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

/** A gateway over a fake context and a memory store, with requests signed as `alice` or `bob`. */
async function start() {
  const ctx = {
    agents: {
      create: ({ sessionId }: { sessionId: string }) => Promise.resolve({
        agent: { followup: vi.fn(), steer: vi.fn(), cancel: vi.fn(), model: fakeModel() },
        dispose: vi.fn(() => Promise.resolve()),
        sessionId,
      }),
      get: () => undefined,
    },
    sessions: { get: () => undefined },
    llm: fakeLlm(),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    tools: { schemas: () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  } as unknown as Context
  const store = new MemoryStore()
  const api = new AgentsGateway(ctx, ownerHeader, '/v1', store, new SessionRegistry(), testGatewayOptions(environments, new FakeSessionQuery()))
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  /** Send a request as `owner`; the body is JSON when given. */
  async function call(owner: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${origin}/v1${path}`, {
      method,
      headers: { 'x-owner': owner, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: await res.json() }
  }

  return { call, store }
}

const WORKSPACE = { type: 'local', workspace_directory: '/tmp/agentry-project-spec' } as const
const DEFAULT_WORKSPACE = { type: 'local', workspace_directory: '/tmp/agentry-project-default' } as const
const DETAILS = { name: 'Work', agent_id: 'agent_1', environment: WORKSPACE, pinned: true }

async function createProject(call: Awaited<ReturnType<typeof start>>['call'], overrides: Record<string, unknown> = {}): Promise<any> {
  const { status, body } = await call('alice', 'POST', '/agents/projects', { ...DETAILS, ...overrides })
  expect(status).toBe(201)
  return body
}

/** A project's fields apart from `updated_at`, which each edit legitimately bumps. */
function projectWithoutUpdatedAt(project: Record<string, unknown>): Record<string, unknown> {
  const stable: Record<string, unknown> = { ...project }
  delete stable.updated_at
  return stable
}

/** Save an agent owned by Alice for a Project default or a session override. */
async function seedAgent(store: MemoryStore, model: string, instructions: string) {
  await store.ensureOwner(ALICE)
  return store.agents.create(ALICE, materializeAgent({ model, instructions }))
}

describe('/agents/projects', () => {
  it('creates a project with name agent environment and pinned', async () => {
    const { call, store } = await start()
    const { status, body } = await call('alice', 'POST', '/agents/projects', DETAILS)
    expect(status).toBe(201)
    expect(body).toMatchObject({
      object: 'project',
      name: 'Work',
      status: 'active',
      pinned: true,
      agent_id: 'agent_1',
      environment: WORKSPACE,
      archived_at: null,
    })
    expect(typeof body.id).toBe('string')
    expect(typeof body.created_at).toBe('number')
    expect(typeof body.updated_at).toBe('number')
    expect(await store.projects.get(ALICE, body.id)).toMatchObject({ name: 'Work', pinned: true })
    expect((await call('alice', 'GET', '/agents/projects')).body.data.map((row: { id: string }) => row.id)).toEqual([body.id])
  })

  it('rejects an empty project name', async () => {
    const { call, store } = await start()
    const { status, body } = await call('alice', 'POST', '/agents/projects', { name: '   ' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect((await store.projects.list({ owner: ALICE })).data).toEqual([])
  })

  it("answers 404 for another owner's project", async () => {
    const { call } = await start()
    const project = await createProject(call)
    const path = `/agents/projects/${project.id}`
    for (const [method, route, body] of [
      ['GET', path, undefined],
      ['POST', path, { name: 'Stolen' }],
      ['POST', `${path}/archive`, undefined],
      ['POST', `${path}/unarchive`, undefined],
      ['DELETE', path, undefined],
    ] as const) {
      const { status, body: response } = await call('bob', method, route, body)
      expect(status).toBe(404)
      expect(response.error.code).toBe('resource_not_found')
    }
    expect((await call('bob', 'GET', '/agents/projects')).body.data).toEqual([])
    expect((await call('alice', 'GET', path)).body.name).toBe('Work')
  })

  it('updates name agent environment and pinned without losing other fields', async () => {
    const { call, store } = await start()
    const created = await createProject(call)
    const path = `/agents/projects/${created.id}`
    const renamed = await call('alice', 'POST', path, { name: 'Renamed' })
    expect(renamed.status).toBe(200)
    expect(renamed.body).toMatchObject({ ...projectWithoutUpdatedAt(created), name: 'Renamed' })
    const changed = await call('alice', 'POST', path, { agent_id: null, environment: DEFAULT_WORKSPACE, pinned: false })
    expect(changed.status).toBe(200)
    expect(changed.body).toMatchObject({
      ...projectWithoutUpdatedAt(renamed.body),
      name: 'Renamed',
      agent_id: null,
      environment: DEFAULT_WORKSPACE,
      pinned: false,
    })
    expect(await store.projects.get(ALICE, created.id)).toMatchObject({ name: 'Renamed', agent_id: null, pinned: false })
  })

  it('archives and unarchives a project', async () => {
    const { call } = await start()
    const created = await createProject(call)
    const path = `/agents/projects/${created.id}`
    const archived = await call('alice', 'POST', `${path}/archive`)
    expect(archived.status).toBe(200)
    expect(archived.body).toMatchObject({ ...projectWithoutUpdatedAt(created), archived_at: expect.any(Number), status: 'archived' })
    expect(typeof archived.body.archived_at).toBe('number')
    expect((await call('alice', 'GET', '/agents/projects')).body.data).toEqual([])
    expect((await call('alice', 'GET', '/agents/projects?status=archived')).body.data.map((row: { id: string }) => row.id)).toEqual([created.id])
    const restored = await call('alice', 'POST', `${path}/unarchive`)
    expect(restored.status).toBe(200)
    expect(restored.body).toMatchObject({ ...projectWithoutUpdatedAt(archived.body), status: 'active', archived_at: null })
    expect((await call('alice', 'GET', '/agents/projects')).body.data.map((row: { id: string }) => row.id)).toEqual([created.id])
  })

  it('deletes an empty project', async () => {
    const { call, store } = await start()
    const created = await createProject(call)
    const { status, body } = await call('alice', 'DELETE', `/agents/projects/${created.id}`)
    expect(status).toBe(200)
    expect(body).toEqual({ id: created.id, object: 'project.deleted', deleted: true })
    expect(await store.projects.get(ALICE, created.id)).toBeUndefined()
    expect((await call('alice', 'GET', `/agents/projects/${created.id}`)).status).toBe(404)
  })

  it('refuses to delete a project with sessions', async () => {
    const { call, store } = await start()
    const created = await createProject(call)
    const now = new Date('2026-11-27T10:00:00.000Z')
    await store.sessions.insert({
      id: 'sess_project_1',
      ownerId: ALICE,
      agentId: null,
      environmentId: null,
      projectId: created.id,
      dshSessionId: 'sess_project_1',
      status: 'idle',
      lastError: null,
      model: 'deepseek-chat',
      reasoningEffort: null,
      body: null,
      createdAt: now,
      updatedAt: now,
    })
    const { status, body } = await call('alice', 'DELETE', `/agents/projects/${created.id}`)
    expect(status).toBe(409)
    expect(body.error.code).toBe('project_has_sessions')
    expect(await store.projects.get(ALICE, created.id)).toBeDefined()
  })
})

describe('/agents/sessions on projects', () => {
  it('creates a session on a project using its defaults', async () => {
    const { call, store } = await start()
    const agent = await seedAgent(store, 'deepseek-chat', 'Project instructions')
    const project = await createProject(call, { agent_id: agent.id, environment: WORKSPACE })

    const { status, body } = await call('alice', 'POST', '/agents/sessions', { project_id: project.id })
    expect(status).toBe(200)
    expect(body.project_id).toBe(project.id)
    expect(body.agent.id).toBe(agent.id)
    expect(body.agent.model).toBe('deepseek-chat')
    expect(body.agent.instructions).toBe('Project instructions')
    expect(body.environment).toEqual(WORKSPACE)

    const row = await store.sessions.get(body.id, ALICE)
    expect(row?.projectId).toBe(project.id)
    expect(row?.body?.project_id).toBe(project.id)
  })

  it('keeps explicit create overrides while attaching the project', async () => {
    const { call, store } = await start()
    const projectAgent = await seedAgent(store, 'deepseek-chat', 'Project instructions')
    const explicitAgent = await seedAgent(store, 'deepseek-chat', 'Explicit instructions')
    const project = await createProject(call, { agent_id: projectAgent.id, environment: WORKSPACE })

    const inline = await call('alice', 'POST', '/agents/sessions', {
      project_id: project.id,
      agent: { model: 'deepseek-explicit', instructions: 'Inline' },
      environment: DEFAULT_WORKSPACE,
    })
    expect(inline.status).toBe(200)
    expect(inline.body.project_id).toBe(project.id)
    expect(inline.body.agent.model).toBe('deepseek-explicit')
    expect(inline.body.agent.instructions).toBe('Inline')
    expect(inline.body.environment).toEqual(DEFAULT_WORKSPACE)

    const saved = await call('alice', 'POST', '/agents/sessions', {
      project_id: project.id,
      agent_id: explicitAgent.id,
      environment: DEFAULT_WORKSPACE,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.project_id).toBe(project.id)
    expect(saved.body.agent.id).toBe(explicitAgent.id)
    expect(saved.body.agent.instructions).toBe('Explicit instructions')
    expect(saved.body.environment).toEqual(DEFAULT_WORKSPACE)

    expect((await store.sessions.get(saved.body.id, ALICE))?.projectId).toBe(project.id)
    expect((await call('alice', 'GET', `/agents/projects/${project.id}`)).body).toMatchObject({
      agent_id: projectAgent.id,
      environment: WORKSPACE,
    })
  })

  it('refuses a session on an archived project', async () => {
    const { call, store } = await start()
    const project = await createProject(call)
    const body = { agent: { model: 'deepseek-chat' }, project_id: project.id }

    const foreign = await call('bob', 'POST', '/agents/sessions', body)
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe('resource_not_found')

    expect((await call('alice', 'POST', `/agents/projects/${project.id}/archive`)).status).toBe(200)
    const refused = await call('alice', 'POST', '/agents/sessions', body)
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('project_archived')
    expect((await store.sessions.list({ owner: ALICE, limit: 20 })).data).toEqual([])
  })

  it('moves a session into a project and back to unfiled', async () => {
    const { call, store } = await start()
    const project = await createProject(call)
    const created = await call('alice', 'POST', '/agents/sessions', { agent: { model: 'deepseek-chat' } })
    expect(created.status).toBe(200)
    expect(created.body.project_id).toBeNull()
    const path = `/agents/sessions/${created.body.id}`

    const moved = await call('alice', 'POST', path, { project_id: project.id })
    expect(moved.status).toBe(200)
    expect(moved.body.project_id).toBe(project.id)
    expect((await store.sessions.get(created.body.id, ALICE))?.projectId).toBe(project.id)

    const unfiled = await call('alice', 'POST', path, { project_id: null })
    expect(unfiled.status).toBe(200)
    expect(unfiled.body.project_id).toBeNull()
    expect((await store.sessions.get(created.body.id, ALICE))?.projectId).toBeNull()

    const movedWithMerge = await call('alice', 'POST', path, { project_id: project.id, metadata_merge: { moved: 'yes' } })
    expect(movedWithMerge.status).toBe(200)
    expect(movedWithMerge.body.project_id).toBe(project.id)
    expect(movedWithMerge.body.metadata.moved).toBe('yes')
    expect((await store.sessions.get(created.body.id, ALICE))?.projectId).toBe(project.id)
    expect((await call('alice', 'POST', path, { project_id: null })).body.project_id).toBeNull()

    const bobSession = await call('bob', 'POST', '/agents/sessions', { agent: { model: 'deepseek-chat' } })
    const foreign = await call('bob', 'POST', `/agents/sessions/${bobSession.body.id}`, { project_id: project.id })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe('resource_not_found')
    expect((await store.sessions.get(bobSession.body.id, ownerId('bob')))?.projectId).toBeNull()

    await call('alice', 'POST', `/agents/projects/${project.id}/archive`)
    const archived = await call('alice', 'POST', path, { project_id: project.id })
    expect(archived.status).toBe(409)
    expect(archived.body.error.code).toBe('project_archived')
    expect((await store.sessions.get(created.body.id, ALICE))?.projectId).toBeNull()
  })

  it('lists sessions by project_id with pagination', async () => {
    const { call } = await start()
    const project = await createProject(call)
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const created = await call('alice', 'POST', '/agents/sessions', {
        agent: { model: 'deepseek-chat' },
        project_id: project.id,
        metadata: { order: String(i) },
      })
      expect(created.status).toBe(200)
      ids.push(created.body.id)
    }
    const unfiled = await call('alice', 'POST', '/agents/sessions', { agent: { model: 'deepseek-chat' } })
    expect(unfiled.body.project_id).toBeNull()

    const newestFirst = [...ids].reverse()
    const firstPage = await call('alice', 'GET', `/agents/sessions?project_id=${project.id}&limit=2`)
    expect(firstPage.status).toBe(200)
    expect(firstPage.body.data.map((row: { id: string }) => row.id)).toEqual(newestFirst.slice(0, 2))
    expect(firstPage.body.data.every((row: { project_id: string | null }) => row.project_id === project.id)).toBe(true)
    expect(firstPage.body.has_more).toBe(true)

    const secondPage = await call('alice', 'GET', `/agents/sessions?project_id=${project.id}&limit=2&after=${firstPage.body.last_id}`)
    expect(secondPage.status).toBe(200)
    expect(secondPage.body.data.map((row: { id: string }) => row.id)).toEqual([newestFirst[2]])
    expect(secondPage.body.has_more).toBe(false)

    const unfiledPage = await call('alice', 'GET', '/agents/sessions?project_id=')
    expect(unfiledPage.body.data.map((row: { id: string }) => row.id)).toEqual([unfiled.body.id])
    const foreign = await call('bob', 'GET', `/agents/sessions?project_id=${project.id}`)
    expect(foreign.body.data).toEqual([])
  })
})
