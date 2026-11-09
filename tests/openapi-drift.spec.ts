/**
 * The routes the gateways register and the paths `openapi/agentry.yaml`
 * declares must be the same set of `METHOD path` pairs.
 */

import { describe, expect, it } from 'vitest'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { openAuthenticator } from './open-auth.ts'
import { loadSpec } from './support/openapi.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'
import type { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])

/** Routes registered outside any gateway: `GET /health` is mounted by the plugin entry. */
const PLUGIN_ROUTES = ['GET /health']

/**
 * Convert a route pattern to OpenAPI path syntax: `:id` and `*path` become `{id}` and `{path}`.
 * @param pattern - gateway pattern relative to its prefix.
 */
function toOpenApiPath(pattern: string): string {
  return pattern.split('/').map(part => part.startsWith(':') || part.startsWith('*') ? `{${part.slice(1)}}` : part).join('/')
}

/**
 * Route sets to compare with the spec. Add the admin gateway here when
 * `AdminGateway.routeTable()` exists (prefix `/admin/v1`).
 */
function routeSets(): Array<{ prefix: string; routes: ReadonlyArray<{ method: string; pattern: string }> }> {
  const agents = new AgentsGateway(
    {} as unknown as Context,
    openAuthenticator,
    '/v1',
    new MemoryStore(),
    new SessionRegistry(),
    testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-openapi-drift')), new FakeSessionQuery()),
  )
  return [{ prefix: '/v1', routes: agents.routeTable() }]
}

describe('openapi drift', () => {
  it('routes and OpenAPI paths match', () => {
    const fromRoutes = [
      ...routeSets().flatMap(({ prefix, routes }) => routes.map(r => `${r.method} ${prefix}${toOpenApiPath(r.pattern)}`)),
      ...PLUGIN_ROUTES,
    ].sort()
    const paths = loadSpec()['paths'] as Record<string, Record<string, unknown>>
    const fromSpec = Object.entries(paths)
      .flatMap(([path, item]) => Object.keys(item).filter(key => HTTP_METHODS.has(key)).map(method => `${method.toUpperCase()} ${path}`))
      .sort()
    expect(fromSpec).toEqual(fromRoutes)
  })

  it('declares no admin paths until the admin API exists', () => {
    const paths = Object.keys(loadSpec()['paths'] as object)
    expect(paths.filter(path => path.startsWith('/admin'))).toEqual([])
  })

  it('declares bearer security, the beta header, and the error envelope', () => {
    const spec = loadSpec()
    const components = spec['components'] as Record<string, Record<string, unknown>>
    expect(components['securitySchemes']).toHaveProperty('bearerAuth')
    expect(components['parameters']).toHaveProperty('OpenAIBeta')
    expect(components['schemas']).toHaveProperty('ErrorResponse')
    expect(spec['openapi']).toMatch(/^3\.1\./)
  })
})
