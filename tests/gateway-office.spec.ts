/** `GET /v1/agents/sessions/{id}/renders/pdf/*path`: Office files converted by DSH's officeToPdf. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import type { OfficeToPdfLike } from '../src/render/office-api.ts'
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

function row(id: string, owner = 'test'): SessionIndexRow {
  const now = new Date()
  return { id, ownerId: ownerId(owner), agentId: null, environmentId: null, projectId: null, dshSessionId: id, status: 'idle', lastError: null, model: 'm', reasoningEffort: null, body: null, createdAt: now, updatedAt: now }
}

async function start(service: OfficeToPdfLike | undefined) {
  const workspace = await mkdtemp(join(tmpdir(), 'agentry-office-spec-'))
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await writeFile(join(workspace, 'docs', 'deck.pptx'), 'PK-fake-deck')
  await writeFile(join(workspace, 'notes.txt'), 'plain')
  const store = new MemoryStore()
  await store.ensureOwner(ownerId('test'))
  await store.ensureOwner(ownerId('other'))
  await store.sessions.insert(row('sess_a'))
  await store.sessions.insert(row('sess_b', 'other'))
  const query = new FakeSessionQuery()
  query.cwd = workspace
  query.append('sess_a', logEvent('turn/start', { turn: 1 }, 1))
  const ctx = { logger: { warn: vi.fn(), info: vi.fn() }, get: () => undefined } as unknown as Context
  const options = { ...testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-office-spec-envs')), query), officeToPdf: () => service }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, new SessionRegistry(), options)
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/sessions`
  return { base, workspace }
}

function fakeService(impl?: () => Promise<{ pdf: Uint8Array; missingFonts: string[] }>) {
  const convert = vi.fn<OfficeToPdfLike['convert']>(async (request) => {
    if (impl) return impl()
    const read = await request.source.read(new AbortController().signal, 1024)
    expect(new TextDecoder().decode(read.bytes)).toBe('PK-fake-deck')
    return { pdf: new TextEncoder().encode('%PDF-1.7 fake'), missingFonts: ['Calibri', 'Noto Sans'] }
  })
  return { convert }
}

describe('office renders', () => {
  it('converts a pptx: PDF bytes, etag, missing fonts; a matching etag answers 304 without converting', async () => {
    const service = fakeService()
    const { base } = await start(service)
    const res = await fetch(`${base}/sess_a/renders/pdf/docs/deck.pptx`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('x-agentry-missing-fonts')).toBe('Calibri,Noto%20Sans')
    expect(await res.text()).toBe('%PDF-1.7 fake')
    const etag = res.headers.get('etag')!
    expect(etag).toMatch(/^"12:\d+"$/)
    expect(service.convert).toHaveBeenCalledTimes(1)
    expect(service.convert.mock.calls[0]![0]).toMatchObject({ extension: 'pptx', priority: 'foreground', source: { bytes: 12 } })
    expect(service.convert.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)

    const again = await fetch(`${base}/sess_a/renders/pdf/docs/deck.pptx`, { headers: { 'if-none-match': etag } })
    expect(again.status).toBe(304)
    expect(service.convert).toHaveBeenCalledTimes(1)
  })

  it('refuses other formats, escapes, missing files and other owners', async () => {
    const service = fakeService()
    const { base } = await start(service)
    const bad = await fetch(`${base}/sess_a/renders/pdf/notes.txt`)
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('unsupported_format')
    expect((await fetch(`${base}/sess_a/renders/pdf/..%2Fx.pptx`)).status).toBe(400)
    expect((await fetch(`${base}/sess_a/renders/pdf/missing.pptx`)).status).toBe(404)
    expect((await fetch(`${base}/sess_b/renders/pdf/docs/deck.pptx`)).status).toBe(404)
    expect(service.convert).not.toHaveBeenCalled()
  })

  it('answers 413 above 50 MB without converting', async () => {
    const service = fakeService()
    const { base, workspace } = await start(service)
    const { truncate } = await import('node:fs/promises')
    await writeFile(join(workspace, 'big.docx'), '')
    await truncate(join(workspace, 'big.docx'), 50 * 1024 * 1024 + 1)
    const res = await fetch(`${base}/sess_a/renders/pdf/big.docx`)
    expect(res.status).toBe(413)
    expect(service.convert).not.toHaveBeenCalled()
  })

  it('answers 503 when the profile has no converter', async () => {
    const { base } = await start(undefined)
    const res = await fetch(`${base}/sess_a/renders/pdf/docs/deck.pptx`)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('render_unavailable')
  })

  it('maps converter failures without leaking their text', async () => {
    const timeout = fakeService(() => Promise.reject(Object.assign(new Error('soffice crashed at 0xdead'), { code: 'timeout' })))
    const { base } = await start(timeout)
    const res = await fetch(`${base}/sess_a/renders/pdf/docs/deck.pptx`)
    expect(res.status).toBe(504)
    const body = await res.text()
    expect(body).toContain('render_timeout')
    expect(body).not.toContain('0xdead')

    const busy = fakeService(() => Promise.reject(Object.assign(new Error('x'), { code: 'busy' })))
    const second = await start(busy)
    const answer = await fetch(`${second.base}/sess_a/renders/pdf/docs/deck.pptx`)
    expect(answer.status).toBe(503)
    expect(answer.headers.get('retry-after')).toBe('5')
  })
})
