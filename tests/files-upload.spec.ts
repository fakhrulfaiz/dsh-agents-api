import { request as httpRequest } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

/** Files and partial writes under the staging directory. */
async function stagedKeys(harness: Harness): Promise<string[]> {
  return (await harness.staging.list()).map(entry => entry.key).sort()
}

/** POST a chunked multipart body, so no `Content-Length` header can reject it early. */
function chunkedUpload(harness: Harness, owner: string, filename: string, bytes: Buffer): Promise<{ status: number; body: any }> {
  const boundary = '----agentry'
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  const tail = `\r\n--${boundary}--\r\n`
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${harness.origin}/v1/agents/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      })
    })
    req.on('error', reject)
    req.write(head)
    req.write(bytes)
    req.end(tail)
  })
}

describe('POST /agents/files', () => {
  it('stages the bytes under a random id and answers the file object', async () => {
    const h = await start()
    const { status, body } = await h.upload('alice', 'shot.png', PNG, 'image/png')
    expect(status).toBe(201)
    expect(body).toMatchObject({ object: 'file', bytes: PNG.length, filename: 'shot.png', purpose: 'user_data', media_type: 'image/png', status: 'staged' })
    expect(body['id']).toMatch(/^file_[a-f0-9]{24}$/u)
    expect(typeof body['created_at']).toBe('number')
    const keys = await stagedKeys(h)
    expect(keys).toEqual([`alice/${body['id']}`])
    expect(keys[0]).not.toContain('shot')
    expect(await readFile(join(h.stagingDir, keys[0]!))).toEqual(PNG)
    const row = await h.store.files.get(body['id'], 'alice' as never)
    expect(row).toMatchObject({ status: 'staged', mediaType: 'image/png', bytes: PNG.length, name: 'shot.png' })
    expect(row?.sha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('requires authentication', async () => {
    const h = await start()
    const res = await fetch(`${h.origin}/v1/agents/files`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('answers 501 uploads_disabled when uploads.dir is not set', async () => {
    const h = await start({ uploadsOff: true })
    const { status, body } = await h.upload('alice', 'a.txt', 'hello', 'text/plain')
    expect(status).toBe(501)
    expect(body['error']).toMatchObject({ code: 'uploads_disabled' })
  })

  it('rejects an oversized Content-Length with 413 before reading the body', async () => {
    const h = await start({ limits: { maxFileBytes: 1000 } })
    const { status, body } = await h.upload('alice', 'big.txt', Buffer.alloc(200 * 1024, 97), 'text/plain')
    expect(status).toBe(413)
    expect(body['error']).toMatchObject({ code: 'file_too_large' })
    expect(await stagedKeys(h)).toEqual([])
  })

  it('aborts a streamed upload at the limit, removes the partial file, and stores no row', async () => {
    const h = await start({ limits: { maxFileBytes: 5000 } })
    const { status, body } = await chunkedUpload(h, 'alice', 'big.txt', Buffer.alloc(20_000, 97))
    expect(status).toBe(413)
    expect(body.error.code).toBe('file_too_large')
    expect(await stagedKeys(h)).toEqual([])
    expect(await h.store.files.stagedBytes('alice' as never)).toBe(0)
  })

  it('accepts a file exactly at the limit', async () => {
    const h = await start({ limits: { maxFileBytes: 5000 } })
    expect((await h.upload('alice', 'ok.txt', Buffer.alloc(5000, 97), 'text/plain')).status).toBe(201)
    expect((await chunkedUpload(h, 'alice', 'one-over.txt', Buffer.alloc(5001, 97))).status).toBe(413)
  })

  it.each([
    ['text bytes named .png', 'cat.png', Buffer.from('not an image'), 'image/png'],
    ['png bytes named .jpg', 'photo.jpg', PNG, 'image/jpeg'],
    ['png bytes declared as jpeg', 'photo.png', PNG, 'image/jpeg'],
    ['an executable name', 'run.exe', Buffer.from('MZ....'), 'application/octet-stream'],
    ['an SVG by default', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
    ['HTML by default', 'page.html', Buffer.from('<script>alert(1)</script>'), 'text/html'],
    ['a name without an extension', 'README', Buffer.from('hello'), 'text/plain'],
    ['binary bytes named .txt', 'notes.txt', Buffer.from([0x68, 0x00, 0x69]), 'text/plain'],
    ['a fake PDF', 'doc.pdf', Buffer.from('hello'), 'application/pdf'],
    ['a fake Office file', 'sheet.xlsx', Buffer.from('hello'), 'application/octet-stream'],
  ])('rejects %s with 415', async (_label, name, bytes, type) => {
    const h = await start()
    const { status, body } = await h.upload('alice', name, bytes, type)
    expect(status).toBe(415)
    expect(body['error']).toMatchObject({ code: 'unsupported_media_type' })
    expect(await stagedKeys(h)).toEqual([])
    expect(await h.store.files.stagedBytes('alice' as never)).toBe(0)
  })

  it('accepts the declared octet-stream type when the bytes and extension agree, and decides the type itself', async () => {
    const h = await start()
    const pdf = await h.upload('alice', 'doc.pdf', Buffer.from('%PDF-1.7\nhello'), 'application/octet-stream')
    expect(pdf.body).toMatchObject({ media_type: 'application/pdf' })
    const csv = await h.upload('alice', 'data.csv', 'a,b\n1,2\n', 'application/vnd.ms-excel')
    expect(csv.body).toMatchObject({ media_type: 'text/csv' })
    const zip = await h.upload('alice', 'bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), '')
    expect(zip.body).toMatchObject({ media_type: 'application/zip' })
  })

  it('rejects an empty file with 400', async () => {
    const h = await start()
    const { status, body } = await h.upload('alice', 'empty.txt', '', 'text/plain')
    expect(status).toBe(400)
    expect(body['error']).toMatchObject({ code: 'invalid_file' })
  })

  it('keeps only the leaf of a traversal name and never writes outside the staging directory', async () => {
    const h = await start()
    const { status, body } = await h.upload('alice', '../../../etc/passwd.txt', 'x', 'text/plain')
    expect(status).toBe(201)
    expect(body['filename']).toBe('passwd.txt')
    const windows = await h.upload('alice', '..\\..\\boot.ini.txt', 'x', 'text/plain')
    expect(windows.body['filename']).toBe('boot.ini.txt')
    expect(await stagedKeys(h)).toHaveLength(2)
    expect(await readdir(h.root)).toEqual(expect.arrayContaining(['staging']))
    expect((await readdir(h.root)).sort()).toEqual(['staging'])
  })

  it.each(['..', '.', '', '   ', '...', '???'])('rejects the unusable name %j with 400', async (name) => {
    const h = await start()
    const { status, body } = await h.upload('alice', name, 'x', 'text/plain')
    expect(status).toBe(400)
    expect(body['error']).toMatchObject({ code: 'invalid_file' })
    expect(await stagedKeys(h)).toEqual([])
  })

  it('refuses more than one file, a wrongly named part, a bad purpose, no file, and a non-multipart body', async () => {
    const h = await start()
    const two = await h.upload('alice', 'a.txt', 'a', 'text/plain', form => form.append('file', new Blob(['b']), 'b.txt'))
    expect(two.status).toBe(400)
    const misnamed = await fetch(`${h.origin}/v1/agents/files`, { method: 'POST', headers: { authorization: 'Bearer alice' }, body: (() => {
      const form = new FormData()
      form.append('attachment', new Blob(['a']), 'a.txt')
      return form
    })() })
    expect(misnamed.status).toBe(400)
    const purpose = await h.upload('alice', 'a.txt', 'a', 'text/plain', form => form.append('purpose', 'assistants'))
    expect(purpose.status).toBe(400)
    expect((await h.upload('alice', 'a.txt', 'a', 'text/plain', form => form.append('purpose', 'user_data'))).status).toBe(201)
    const none = await fetch(`${h.origin}/v1/agents/files`, { method: 'POST', headers: { authorization: 'Bearer alice' }, body: new FormData() })
    expect(none.status).toBe(400)
    const json = await fetch(`${h.origin}/v1/agents/files`, { method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json' }, body: '{}' })
    expect(json.status).toBe(400)
    expect(await stagedKeys(h)).toHaveLength(1)
  })

  it('enforces the per-owner staged-bytes quota and keeps owners apart', async () => {
    const h = await start({ limits: { maxFileBytes: 1000, maxStagedBytesPerOwner: 1500 } })
    expect((await h.upload('alice', 'a.txt', Buffer.alloc(1000, 97), 'text/plain')).status).toBe(201)
    const over = await h.upload('alice', 'b.txt', Buffer.alloc(1000, 97), 'text/plain')
    expect(over.status).toBe(429)
    expect(over.body['error']).toMatchObject({ code: 'staging_quota_exceeded' })
    expect((await h.upload('bob', 'b.txt', Buffer.alloc(1000, 97), 'text/plain')).status).toBe(201)
    expect(await stagedKeys(h)).toHaveLength(2)
  })

  it('stages two files of one owner independently', async () => {
    const h = await start()
    const a = await h.upload('alice', 'same.txt', 'one', 'text/plain')
    const b = await h.upload('alice', 'same.txt', 'two', 'text/plain')
    expect(a.body['id']).not.toBe(b.body['id'])
    expect(await stagedKeys(h)).toHaveLength(2)
  })
})
