/** `GET /v1/agents/tools` reads the default preset scope through `agentPresets.acquireScope()`. */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { openAuthenticator } from './open-auth.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'

const servers: Server[] = []
const environments = createLocalProvider(join(tmpdir(), 'agentry-host-tool-catalog-spec'))

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

const PRESET_SCOPE = { name: 'preset-scope' }

/**
 * Serve the tool catalog over a context whose global `schemas()` is empty and
 * whose preset scope lists `office_probe`, as the web profile does.
 */
async function start(presets: unknown) {
  const schemas = vi.fn((scope?: unknown) => scope === PRESET_SCOPE
    ? [{ name: 'office_probe', description: 'Probe', parameters: { type: 'object', properties: {} } }]
    : [])
  const ctx = {
    logger: { warn: vi.fn() },
    get: (name: string) => name === 'agentPresets' ? presets : undefined,
    tools: { schemas },
  } as unknown as Context
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(environments, new FakeSessionQuery()))
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/tools`, schemas }
}

describe('GET /v1/agents/tools preset scope', () => {
  it('lists the default preset scope and releases its lease', async () => {
    const released = vi.fn()
    const { url, schemas } = await start({
      acquireScope: () => Promise.resolve({ key: PRESET_SCOPE, [Symbol.asyncDispose]: () => { released(); return Promise.resolve() } }),
    })
    const body = await (await fetch(url)).json() as { data: Array<{ name: string }> }
    expect(body.data.map(tool => tool.name)).toEqual(['office_probe'])
    expect(schemas).toHaveBeenCalledWith(PRESET_SCOPE)
    expect(released).toHaveBeenCalledOnce()
  })

  it('keeps the global registry when no preset roster exists', async () => {
    const { url, schemas } = await start(undefined)
    const body = await (await fetch(url)).json() as { data: unknown[] }
    expect(body.data).toEqual([])
    expect(schemas).toHaveBeenCalledWith()
  })
})
