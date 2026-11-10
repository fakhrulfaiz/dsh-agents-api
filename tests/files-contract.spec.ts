/**
 * File routes, file input parts, and file item parts validate against `openapi/agentry.yaml`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { logEvent } from './support/fake-session-query.ts'
import { filesHarness, PNG } from './support/files-harness.ts'
import { SpecValidator } from './support/openapi.ts'

const spec = new SpecValidator()
type Harness = Awaited<ReturnType<typeof filesHarness>>
const open: Harness[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map(harness => harness.close()))
})

async function start(options?: Parameters<typeof filesHarness>[0]): Promise<Harness> {
  const harness = await filesHarness(options)
  open.push(harness)
  return harness
}

describe('files contract', () => {
  it('upload, delete, and the error responses match the spec', async () => {
    const h = await start({ limits: { maxFileBytes: 100, maxStagedBytesPerOwner: 150 } })
    const ok = await h.upload('alice', 'a.txt', 'hello', 'text/plain')
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(spec.response('POST', '/v1/agents/files', 201, ok.body)).toEqual([])
    expect(spec.schema('FileObject', ok.body)).toEqual([])
    const bad = await h.upload('alice', 'a.exe', 'MZ', 'application/octet-stream')
    expect(spec.response('POST', '/v1/agents/files', 415, bad.body)).toEqual([])
    const empty = await h.upload('alice', 'e.txt', '', 'text/plain')
    expect(spec.response('POST', '/v1/agents/files', 400, empty.body)).toEqual([])
    const big = await h.upload('alice', 'b.txt', 'x'.repeat(100 * 1024), 'text/plain')
    expect([big.status, spec.response('POST', '/v1/agents/files', 413, big.body)]).toEqual([413, []])
    await h.upload('alice', 'c.txt', 'x'.repeat(100), 'text/plain')
    const quota = await h.upload('alice', 'd.txt', 'x'.repeat(100), 'text/plain')
    expect([quota.status, spec.response('POST', '/v1/agents/files', 429, quota.body)]).toEqual([429, []])
    const deleted = await h.request('alice', 'DELETE', `/agents/files/${ok.body['id']}`)
    expect(spec.response('DELETE', '/v1/agents/files/{file_id}', 200, deleted.body)).toEqual([])
    const missing = await h.request('alice', 'DELETE', `/agents/files/${ok.body['id']}`)
    expect(spec.response('DELETE', '/v1/agents/files/{file_id}', 404, missing.body)).toEqual([])
  })

  it('declares 501 when uploads are off, and 409 for an attached file', async () => {
    const off = await start({ uploadsOff: true })
    const res = await off.upload('alice', 'a.txt', 'x', 'text/plain')
    expect(spec.response('POST', '/v1/agents/files', 501, res.body)).toEqual([])
    const h = await start()
    const file = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    await h.store.files.claim('alice' as never, [file.body['id']], 'sess_1')
    const conflict = await h.request('alice', 'DELETE', `/agents/files/${file.body['id']}`)
    expect(spec.response('DELETE', '/v1/agents/files/{file_id}', 409, conflict.body)).toEqual([])
  })

  it('content declares its headers and a 404 error body', async () => {
    const h = await start()
    const file = await h.upload('alice', 'a.png', PNG, 'image/png')
    const res = await fetch(`${h.origin}/v1/agents/files/${file.body['id']}/content`, { headers: { authorization: 'Bearer alice' } })
    expect(res.status).toBe(200)
    const operation = ((spec.spec['paths'] as Record<string, any>)['/v1/agents/files/{file_id}/content']).get
    expect(Object.keys(operation.responses['200'].headers)).toEqual(expect.arrayContaining(['Content-Disposition', 'Content-Length']))
    const miss = await h.request('bob', 'GET', `/agents/files/${file.body['id']}/content`)
    expect(spec.response('GET', '/v1/agents/files/{file_id}/content', 404, miss.body)).toEqual([])
  })

  it('send requests and file item parts match the spec', async () => {
    const h = await start()
    const png = await h.upload('alice', 'shot.png', PNG, 'image/png')
    const txt = await h.upload('alice', 'n.txt', 'hello', 'text/plain')
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', file_id: png.body['id'] }, { type: 'input_file', file_id: txt.body['id'] }] }]
    const body = { agent: { model: 'deepseek-flash' }, environment: { type: 'none' }, input }
    expect(spec.request('POST', '/v1/agents/sessions', body)).toEqual([])
    const created = await h.request('alice', 'POST', '/agents/sessions', body)
    expect([created.status, spec.response('POST', '/v1/agents/sessions', 200, created.body)]).toEqual([200, []])
    const sessionId = created.body!['id'] as string
    const user = h.agents.get(sessionId)!.followup.mock.calls[0]![0] as { content: unknown; source: unknown }
    h.query.append(sessionId, logEvent('user/message', { content: user.content, source: user.source }, 1))
    const items = await h.request('alice', 'GET', `/agents/sessions/${sessionId}/items`)
    expect(spec.response('GET', '/v1/agents/sessions/{session_id}/items', 200, items.body)).toEqual([])
    expect(items.body!['data'][0].content.map((part: { type: string }) => part.type)).toEqual(['input_text', 'input_image', 'input_file'])
    const missing = await h.request('alice', 'POST', `/agents/sessions/${sessionId}/events`, { type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_nope' }] }] })
    expect([missing.status, spec.response('POST', '/v1/agents/sessions/{session_id}/events', 404, missing.body)]).toEqual([404, []])
    const unsupported = await h.request('alice', 'POST', `/agents/sessions/${sessionId}/events`, { type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://x/y.png' }] }] })
    expect([unsupported.status, spec.response('POST', '/v1/agents/sessions/{session_id}/events', 400, unsupported.body)]).toEqual([400, []])
  })
})
