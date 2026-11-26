import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { filesHarness, PNG } from './support/files-harness.ts'

type Harness = Awaited<ReturnType<typeof filesHarness>>
const open: Harness[] = []

async function start(options?: Parameters<typeof filesHarness>[0]): Promise<Harness> {
  const harness = await filesHarness(options)
  open.push(harness)
  return harness
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(harness => harness.close()))
})

async function get(h: Harness, owner: string | undefined, id: string) {
  const res = await fetch(`${h.origin}/v1/agents/files/${id}/content`, { headers: owner === undefined ? {} : { authorization: `Bearer ${owner}` } })
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }
}

describe('GET /agents/files/{id}/content', () => {
  it('serves a staged image inline with hardening headers', async () => {
    const h = await start()
    const { body } = await h.upload('alice', 'shot.png', PNG, 'image/png')
    const res = await get(h, 'alice', body['id'])
    expect(res.status).toBe(200)
    expect(res.bytes).toEqual(PNG)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-length')).toBe(String(PNG.length))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
  })

  it('serves a non-image as an attachment with an encoded UTF-8 filename', async () => {
    const h = await start()
    const { body } = await h.upload('alice', 'résumé (final).txt', 'hello', 'text/plain')
    const res = await get(h, 'alice', body['id'])
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="r_+sum_+ \(final\)\.txt"; filename\*=UTF-8''r%C3%A9sum%C3%A9%20%28final%29\.txt$/u)
    expect(res.bytes.toString()).toBe('hello')
  })

  it('serves SVG and HTML, when a deployment allows them, as octet-stream attachments', async () => {
    const h = await start({ limits: { allowedMediaTypes: ['image/svg+xml', 'text/html', 'image/png'] } })
    const svg = await h.upload('alice', 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml')
    expect(svg.status).toBe(201)
    const res = await get(h, 'alice', svg.body['id'])
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="logo\.svg"/u)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const html = await h.upload('alice', 'page.html', '<script>alert(1)</script>', 'text/html')
    expect((await get(h, 'alice', html.body['id'])).headers.get('content-type')).toBe('application/octet-stream')
  })

  it('answers 404 for another owner, exactly like an unknown id, and 401 without a credential', async () => {
    const h = await start()
    const { body } = await h.upload('alice', 'a.txt', 'secret', 'text/plain')
    const foreign = await get(h, 'mallory', body['id'])
    const unknown = await get(h, 'mallory', 'file_000000000000000000000000')
    expect(foreign.status).toBe(404)
    expect(foreign.bytes.toString().replace(body['id'], 'ID')).toBe(unknown.bytes.toString().replace('file_000000000000000000000000', 'ID'))
    expect(foreign.bytes.toString()).not.toContain('secret')
    expect((await get(h, undefined, body['id'])).status).toBe(401)
    expect((await get(h, 'alice', body['id'])).status).toBe(200)
  })

  it('answers 404 when the staged bytes are gone', async () => {
    const h = await start()
    const { body } = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    await rm(join(h.stagingDir, 'alice', body['id']))
    expect((await get(h, 'alice', body['id'])).status).toBe(404)
  })

  it('never takes a path: an id with traversal characters is a plain 404', async () => {
    const h = await start()
    for (const id of ['..', '%2e%2e', '..%2F..%2Fetc%2Fpasswd', 'file_x%2F..%2F..']) {
      const res = await get(h, 'alice', id)
      expect(res.status, id).toBe(404)
    }
  })

  it('serves an attached image from the DSH store (normalized form) and an attached file by verified stream', async () => {
    const h = await start()
    await h.store.ensureOwner('alice' as never)
    const image = await h.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'shot.png' })
    const file = await h.attachments.saveFileStream({ data: (async function* () { yield Buffer.from('notes') })(), name: 'notes.txt' })
    const base = { ownerId: 'alice' as never, sha256: 'a'.repeat(64), status: 'attached' as const, sessionId: 'sess_1', createdAt: new Date(), attachedAt: new Date(), workspacePath: 'uploads/x' }
    await h.store.files.insert({ ...base, id: 'file_img', name: 'shot.png', mediaType: 'image/png', bytes: PNG.length, attachment: { kind: 'image', ref: image } })
    await h.store.files.insert({ ...base, id: 'file_txt', name: 'notes.txt', mediaType: 'text/plain', bytes: 5, attachment: { kind: 'file', ref: file } })
    const img = await get(h, 'alice', 'file_img')
    expect(img.status).toBe(200)
    expect(img.bytes).toEqual(PNG)
    expect(img.headers.get('content-disposition')).toBe('inline')
    const txt = await get(h, 'alice', 'file_txt')
    expect(txt.bytes.toString()).toBe('notes')
    expect(txt.headers.get('content-disposition')).toMatch(/^attachment/u)
    expect((await get(h, 'bob', 'file_img')).status).toBe(404)
  })

  it('answers 503 attachments_unavailable for an attached file when the profile has no attachment service', async () => {
    const h = await start({ noAttachments: true })
    await h.store.ensureOwner('alice' as never)
    await h.store.files.insert({
      id: 'file_1', ownerId: 'alice' as never, name: 'a.txt', mediaType: 'text/plain', bytes: 1, sha256: 'a'.repeat(64), status: 'attached', sessionId: 's',
      attachment: { kind: 'file', ref: { attachmentId: AttachmentId('x'), name: 'a.txt', bytes: 1 } }, workspacePath: 'uploads/a.txt', createdAt: new Date(), attachedAt: new Date(),
    })
    const res = await get(h, 'alice', 'file_1')
    expect(res.status).toBe(503)
    expect(JSON.parse(res.bytes.toString())).toMatchObject({ error: { code: 'attachments_unavailable' } })
  })
})

describe('DELETE /agents/files/{id}', () => {
  it('removes a staged file, its row, and its bytes', async () => {
    const h = await start()
    const { body } = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    const res = await h.request('alice', 'DELETE', `/agents/files/${body['id']}`)
    expect(res).toMatchObject({ status: 200, body: { id: body['id'], object: 'file.deleted', deleted: true } })
    expect(await h.staging.list()).toEqual([])
    expect(await h.store.files.get(body['id'], 'alice' as never)).toBeUndefined()
    expect((await h.request('alice', 'DELETE', `/agents/files/${body['id']}`)).status).toBe(404)
  })

  it("answers 404 for another owner's file and leaves it untouched", async () => {
    const h = await start()
    const { body } = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    expect((await h.request('mallory', 'DELETE', `/agents/files/${body['id']}`)).status).toBe(404)
    expect(await h.staging.list()).toHaveLength(1)
    expect((await get(h, 'alice', body['id'])).status).toBe(200)
  })

  it('answers 409 file_attached for an attached file', async () => {
    const h = await start()
    const { body } = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    await h.store.files.claim('alice' as never, [body['id']], 'sess_1')
    const res = await h.request('alice', 'DELETE', `/agents/files/${body['id']}`)
    expect(res.status).toBe(409)
    expect(res.body?.['error']).toMatchObject({ code: 'file_attached' })
    expect(await h.store.files.get(body['id'], 'alice' as never)).toMatchObject({ status: 'attached' })
  })
})

describe('route order', () => {
  it('keeps /agents/files out of the saved-agent routes', async () => {
    const h = await start()
    const { body } = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    expect(body['object']).toBe('file')
    expect((await h.request('alice', 'GET', '/agents/files')).body).toMatchObject({ object: 'list' })
  })
})
