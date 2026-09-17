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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as AgentsApi from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('serves POST /v1/agents on a real WebServer', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-experimental-agents-api-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-dependencies',
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-experimental-agents-api'",
      '  config:',
      "    prefix: '/v1'",
      '',
    ].join('\n'))

    const agents = new Map<string, { followup: ReturnType<typeof vi.fn> }>()
    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('sessions', {
          get: (id: string) => agents.has(id) ? { id } : undefined,
        } as never)
        ctx.provide('agents', {
          create: async ({ sessionId }: { sessionId: string }) => {
            const agent = { id: sessionId, followup: vi.fn(), steer: vi.fn(), cancel: vi.fn() }
            agents.set(sessionId, agent)
            return { agent, dispose: async () => {} }
          },
          get: (id: string) => agents.get(id),
        } as never)
      },
    }
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['fixture-dependencies', dependencies],
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-experimental-agents-api', AgentsApi],
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

    const response = await fetch(`http://127.0.0.1:${String(context.webServer.port)}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', name: 'loader' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { object: string; name: string }
    expect(body).toMatchObject({ object: 'agent', name: 'loader' })

    const session = await fetch(`http://127.0.0.1:${String(context.webServer.port)}/v1/agents/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { model: 'deepseek-chat' }, input: 'hello' }),
    })
    expect(session.status).toBe(200)
    const created = await session.json() as { id: string; object: string }
    expect(created.object).toBe('agent.session')
    expect(created.id.startsWith('sess_')).toBe(true)
  })
})
