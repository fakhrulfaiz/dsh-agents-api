/**
 * REAL-composition coverage: a test-only cordis.yml boots the webserver and
 * Agents API plugin through the vendored Loader. Fake `sessions` and `agents`
 * services stand in for the Host loop so the assertion stays on the HTTP
 * routes the composition actually serves.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as AgentsApi from '../src/index.ts'
import { FakeSessionQuery, logEvent } from './support/fake-session-query.ts'
import { startPostgres, type TestPostgres } from './support/postgres.ts'

let root: string | undefined
let context: Context | undefined
let postgres: TestPostgres | undefined

beforeAll(async () => {
  postgres = await startPostgres()
}, 180_000)

afterAll(async () => {
  await postgres?.stop()
})

/**
 * Retry until the store finishes migrating and routes stop answering 503.
 * @param send - issues one request.
 * @returns the first response that is not 503.
 */
async function whenStoreReady(send: () => Promise<Response>): Promise<Response> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const response = await send()
    if (response.status !== 503 || Date.now() > deadline) return response
    await response.body?.cancel()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the webserver and Agents API through the Loader, with fake Host services.
 * @param databaseUrl - Postgres database the plugin migrates and opens.
 * @param query - fake Session log behind `sessionQuery`.
 * @returns the HTTP origin of the webserver.
 */
async function boot(databaseUrl: string, query: FakeSessionQuery): Promise<string> {
  const configPath = join(root!, 'cordis.yml')
  await writeFile(configPath, [
    '- name: fixture-dependencies',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@agentry/api'",
    '  config:',
    "    prefix: '/v1'",
    `    workspaces: '${join(root!, 'workspaces')}'`,
    '    database:',
    `      url: '${databaseUrl}'`,
    '    auth:',
    '      mode: development',
    '      devKey:',
    '        key: loader-key',
    '        owner: loader',
    '',
  ].join('\n'))

  const agents = new Map<string, { followup: ReturnType<typeof vi.fn> }>()
  const dependencies = {
    name: 'fixture-dependencies',
    apply(ctx: Context) {
      ctx.provide('sessions', {
        get: (id: string) => agents.has(id) ? { id } : undefined,
      } as never)
      ctx.provide('sessionQuery', query as never)
      ctx.provide('sessionPersistence', {} as never)
      ctx.provide('agents', {
        create: async ({ sessionId }: { sessionId: string }) => {
          const agent = { id: sessionId, followup: vi.fn(), steer: vi.fn(), cancel: vi.fn() }
          agents.set(sessionId, agent)
          return { agent, dispose: async () => {} }
        },
        resume: async ({ resumeSessionId }: { resumeSessionId: string }) => {
          const agent = { id: resumeSessionId, followup: vi.fn(), steer: vi.fn(), cancel: vi.fn() }
          agents.set(resumeSessionId, agent)
          return { agent, dispose: async () => {} }
        },
        get: (id: string) => agents.get(id),
      } as never)
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      } as never)
      ctx.provide('tools', { schemas: () => [] } as never)
    },
  }
  context = new Context()
  context.baseUrl = pathToFileURL(root!).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture-dependencies', dependencies],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@agentry/api', AgentsApi],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return `http://127.0.0.1:${String(context.webServer.port)}`
}

const headers = { 'content-type': 'application/json', authorization: 'Bearer loader-key' }

describe('real Loader composition', () => {
  it('serves POST /v1/agents on a real WebServer', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-agents-api-loader-'))
    const origin = await boot(postgres!.url, new FakeSessionQuery())

    const response = await whenStoreReady(() => fetch(`${origin}/v1/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'deepseek-chat', name: 'loader' }),
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as { object: string; name: string }
    expect(body).toMatchObject({ object: 'agent', name: 'loader' })

    const session = await fetch(`${origin}/v1/agents/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'hello' }),
    })
    expect(session.status).toBe(200)
    const created = await session.json() as { id: string; object: string }
    expect(created.object).toBe('agent.session')
    expect(created.id.startsWith('sess_')).toBe(true)
  })

  it('serves items and replay after the context is rebuilt', { timeout: 90_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-agents-api-loader-'))
    const url = await postgres!.createDatabase('rebuilt')
    const query = new FakeSessionQuery()
    let origin = await boot(url, query)

    const created = await (await whenStoreReady(() => fetch(`${origin}/v1/agents/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agent: { model: 'deepseek-chat' } }),
    }))).json() as { id: string }
    const events = [
      logEvent('turn/start', { turn: 1 }, 1),
      logEvent('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, 2),
      logEvent('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } }, 3),
      logEvent('turn/end', { reason: { kind: 'completed' } }, 4),
    ]
    for (const event of events) {
      query.append(created.id, event)
      ;(context as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit('session/event', { id: created.id, header: {} }, event)
    }
    const items = async () => (await (await fetch(`${origin}/v1/agents/sessions/${created.id}/items`, { headers })).json() as { data: Array<{ id: string }> }).data.map(item => item.id)
    expect(await items()).toEqual(['item_msg_2', 'item_msg_3'])

    await context?.fiber.dispose()
    context = undefined
    query.crash()
    origin = await boot(url, query)

    expect(await whenStoreReady(() => fetch(`${origin}/v1/agents/sessions/${created.id}/items`, { headers }))
      .then(response => response.json()).then((page: { data: Array<{ id: string }> }) => page.data.map(item => item.id)))
      .toEqual(['item_msg_2', 'item_msg_3'])
    const replay = await fetch(`${origin}/v1/agents/sessions/${created.id}/events`, { headers: { ...headers, 'last-event-id': '8' } })
    const reader = replay.body!.getReader()
    const text = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    expect(text).toMatch(/^id: 9\nevent: agent\.session\.turn\.completed\n/u)
  })
})
