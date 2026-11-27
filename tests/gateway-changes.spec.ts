/** Per-turn changes routes: DSH's workspaceChanges for local chats, the sandbox recorder for sandbox chats. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { ChangesApi } from '../src/history/changes-api.ts'
import { SandboxChanges } from '../src/history/sandbox-changes.ts'
import type { ChangesSummary, WorkspaceChangesLike } from '../src/history/turn-changes.ts'
import { matchRoute } from '../src/http.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import type { SessionIndexRow } from '../src/store/store.ts'
import { openAuthenticator } from './open-auth.ts'
import { FakeSessionQuery, logEvent, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

function row(id: string, owner = 'test'): SessionIndexRow {
  const now = new Date()
  return { id, ownerId: ownerId(owner), agentId: null, environmentId: null, projectId: null, dshSessionId: id, status: 'idle', lastError: null, model: 'm', reasoningEffort: null, body: null, createdAt: now, updatedAt: now }
}

const SUMMARY: ChangesSummary = {
  turn: 1, total: 3, added: 12, deleted: 4,
  files: [
    { path: '/home/u/.bashrc', display: '~/.bashrc', added: 2, deleted: 0 },
    { path: 'src/a.ts', display: 'src/a.ts', added: 10, deleted: 4 },
    { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
  ],
}

async function start(service: WorkspaceChangesLike | undefined) {
  const store = new MemoryStore()
  await store.ensureOwner(ownerId('test'))
  await store.ensureOwner(ownerId('other'))
  await store.sessions.insert(row('sess_a'))
  await store.sessions.insert(row('sess_b', 'other'))
  const query = new FakeSessionQuery()
  for (const event of [
    logEvent('turn/start', { turn: 1 }, 1),
    logEvent('turn/end', { turn: 1 }, 4),
    logEvent('workspace/changes', { turn: 1 }, 5),
    logEvent('turn/start', { turn: 2 }, 6),
    logEvent('turn/end', { turn: 2 }, 7),
  ]) query.append('sess_a', event)
  query.append('sess_b', logEvent('turn/start', { turn: 1 }, 1))
  const ctx = { logger: { warn: vi.fn(), info: vi.fn() }, get: () => undefined } as unknown as Context
  const options = { ...testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-changes-spec-envs')), query), workspaceChanges: () => service }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, new SessionRegistry(), options)
  const root = await listen((req, res) => { void api.handle(req, res) })
  return `${root}/v1/agents/sessions`
}

function fakeService() {
  const signals: AbortSignal[] = []
  const service: WorkspaceChangesLike = {
    summary: vi.fn((_id: string, seq: number) => seq === 5 ? SUMMARY : undefined),
    diff: vi.fn(async (_id: string, _seq: number, index: number, signal: AbortSignal) => {
      signals.push(signal)
      const file = SUMMARY.files[index]!
      return { kind: 'text' as const, path: file.path, display: file.display, before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }] }
    }),
  }
  return { service, signals }
}

describe('changes routes (local chats)', () => {
  it('lists a turn\'s files without outside ones, keeping DSH indexes', async () => {
    const { service } = fakeService()
    const base = await start(service)
    const res = await fetch(`${base}/sess_a/turns/turn_1/changes`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      object: 'agent.session.turn.changes', turn_id: 'turn_1', available: true, total: 2, added: 10, deleted: 4, outside: 1,
      files: [
        { index: 1, path: 'src/a.ts', display: 'src/a.ts', added: 10, deleted: 4 },
        { index: 2, path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
      ],
    })
    expect(await (await fetch(`${base}/sess_a/turns/turn_6/changes`)).json()).toMatchObject({ turn_id: 'turn_6', available: false, files: [] })
    expect((await fetch(`${base}/sess_a/turns/turn_99/changes`)).status).toBe(404)
    expect(await (await fetch(`${base}/sess_a/changes`)).json()).toEqual({ object: 'list', data: [{ turn_id: 'turn_1', total: 2, added: 10, deleted: 4, outside: 1 }] })
  })

  it('serves a listed file\'s diff with an abort signal, never an outside file\'s', async () => {
    const { service, signals } = fakeService()
    const base = await start(service)
    const res = await fetch(`${base}/sess_a/turns/turn_1/changes/1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ object: 'agent.session.turn.change', kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true, coarse: false, hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 2, lines: [' a', '+b'] }] })
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect((await fetch(`${base}/sess_a/turns/turn_1/changes/0`)).status).toBe(404)
    expect((await fetch(`${base}/sess_a/turns/turn_1/changes/7`)).status).toBe(404)
    expect((await fetch(`${base}/sess_a/turns/turn_1/changes/abc`)).status).toBe(404)
    expect(service.diff).toHaveBeenCalledTimes(1)
  })

  it('hides another owner\'s session', async () => {
    const base = await start(fakeService().service)
    expect((await fetch(`${base}/sess_b/changes`)).status).toBe(404)
    expect((await fetch(`${base}/sess_b/turns/turn_1/changes`)).status).toBe(404)
    expect((await fetch(`${base}/sess_b/turns/turn_1/changes/0`)).status).toBe(404)
  })

  it('answers available: false and an empty list without the DSH service', async () => {
    const base = await start(undefined)
    expect(await (await fetch(`${base}/sess_a/turns/turn_1/changes`)).json()).toMatchObject({ available: false, files: [] })
    expect(await (await fetch(`${base}/sess_a/changes`)).json()).toEqual({ object: 'list', data: [] })
  })
})

describe('changes routes (sandbox chats)', () => {
  it('read the sandbox recorder instead of DSH', async () => {
    const T1 = '1'.repeat(40)
    const T2 = '2'.repeat(40)
    const trees = [T1, T2]
    const exec = vi.fn(async (script: string) => script.includes('write-tree')
      ? { code: 0, stdout: `${trees.shift()!}\n`, stderr: '' }
      : script.includes('diff-tree') ? { code: 0, stdout: '1\t0\tb.txt\0', stderr: '' } : { code: 0, stdout: '@@ -0,0 +1 @@\n+x\n', stderr: '' })
    const sandbox = new SandboxChanges({ target: async () => ({ dir: '/workspace', exec }), warn: vi.fn() })
    sandbox.start('sess_s', 'turn_1')
    sandbox.end('sess_s')
    const dsh = fakeService().service
    const api = new ChangesApi({
      requireSession: async () => ({}),
      events: async () => [logEvent('turn/start', { turn: 1 }, 1), logEvent('workspace/changes', { turn: 1 }, 5)],
      workspaceChanges: () => dsh,
      isSandbox: async () => true,
      sandbox,
    })
    const routes = api.routes()
    const base = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      for (const route of routes) {
        const params = matchRoute(route.pattern, url.pathname)
        if (params) return void route.handler(req, res, url, params, { owner: ownerId('test'), roles: new Set() } as never)
      }
      res.writeHead(404).end()
    })
    expect(await (await fetch(`${base}/agents/sessions/sess_s/turns/turn_1/changes`)).json()).toMatchObject({ available: true, total: 1, files: [{ index: 0, path: 'b.txt', added: 1 }] })
    expect(await (await fetch(`${base}/agents/sessions/sess_s/turns/turn_1/changes/0`)).json()).toMatchObject({ kind: 'text', hunks: [{ lines: ['+x'] }] })
    expect(dsh.summary).not.toHaveBeenCalled()
  })
})
