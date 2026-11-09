import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

function fakeContext(): {
  ctx: Context
  register: ReturnType<typeof vi.fn>
  routes: Map<string, Handler>
  listeners: Array<(session: { id: string; header?: { origin?: string; parentSession?: string } }, event: { type: string; seq: number; time: number; data: unknown }) => void>
  /** Listeners by event name; the last registration wins. */
  byName: Map<string, ReturnType<typeof fakeContext>['listeners'][number]>
  effects: Array<Promise<unknown>>
  errors: unknown[]
} {
  const listeners: ReturnType<typeof fakeContext>['listeners'] = []
  const routes = new Map<string, Handler>()
  const byName: ReturnType<typeof fakeContext>['byName'] = new Map()
  const effects: Array<Promise<unknown>> = []
  const errors: unknown[] = []
  const register = vi.fn((route: { path: string; handler: Handler }) => {
    routes.set(route.path, route.handler)
    return () => {}
  })
  const ctx = {
    on(name: string, fn: (typeof listeners)[number]) {
      listeners.push(fn)
      byName.set(name, fn)
      return () => {}
    },
    effect(fn: () => unknown) {
      const result = fn()
      if (result instanceof Promise) effects.push(result.catch(() => undefined))
      return result
    },
    logger: { error: (error: unknown) => errors.push(error), warn: () => undefined },
    webServer: { register },
  }
  return { ctx: ctx as unknown as Context, register, routes, listeners, byName, effects, errors }
}

function call(handler: Handler, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let status = 0
    const res = {
      statusCode: 0,
      setHeader() {},
      writeHead(code: number) {
        status = code
      },
      end(chunk?: string) {
        resolve({ status: status || res.statusCode, body: chunk ?? '' })
      },
    }
    void handler({ url, method: 'GET', headers: { authorization: 'Bearer k', host: 'localhost' } } as unknown as IncomingMessage, res as unknown as ServerResponse)
  })
}

const auth = { mode: 'development' as const, devKey: { key: 'k', owner: 'dev', admin: true } }
const unreachable = { url: 'postgres://agentry@127.0.0.1:1/agentry' }

describe('apply', () => {
  it('registers the prefix handler and ignores events for unknown sessions', async () => {
    const { ctx, register, listeners, byName, effects } = fakeContext()
    apply(ctx, { auth, prefix: '/v1', workspaces: '/tmp/agentry-apply-spec', database: unreachable, skills: { cacheTtlSeconds: 60 }, commands: { cacheTtlSeconds: 60 } })
    apply(ctx, { auth, prefix: '/v1', workspaces: '/tmp/agentry-apply-spec', database: unreachable, skills: { cacheTtlSeconds: 60 }, commands: { cacheTtlSeconds: 60 } })
    expect(register).toHaveBeenCalledTimes(4)
    // Per apply: four approval-bridge listeners (two answerers, session/event, session/disposed), the three gateway listeners, and the schedule resolver.
    expect(listeners).toHaveLength(16)
    expect(byName.has('schedule/resolve-agent')).toBe(true)
    byName.get('session/event')!({ id: 'missing', header: {} }, { type: 'turn/start', seq: 1, time: 1, data: {} })
    await Promise.all(effects)
  })

  it('keeps /v1 at 503 store_unavailable and logs a named error when the database is unreachable', async () => {
    const { ctx, routes, effects, errors } = fakeContext()
    apply(ctx, { auth, prefix: '/v1', workspaces: '/tmp/agentry-apply-spec', database: unreachable, skills: { cacheTtlSeconds: 60 }, commands: { cacheTtlSeconds: 60 } })
    await Promise.all(effects)
    expect(errors).toEqual([expect.objectContaining({ name: 'StoreStartError' })])
    const response = await call(routes.get('/v1')!, '/v1/agents')
    expect(response.status).toBe(503)
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'store_unavailable', message: expect.stringContaining('agents store failed to start') } })
  })
})
