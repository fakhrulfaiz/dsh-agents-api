import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { DEFAULT_ALLOWED_MEDIA_TYPES, stagingDirectory, validateUploads, type UploadsConfig } from '../src/files/config.ts'
import { createFilesystemFileStore, FileNotFoundError, FileTooLargeError } from '../src/files/file-store.ts'
import { numberedName, sanitizeFileName } from '../src/files/names.ts'
import { classifyUpload, servedType, sniffRaster, UploadRejection } from '../src/files/sniff.ts'
import { PNG } from './support/files-harness.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentry-units-'))
  dirs.push(dir)
  return dir
}

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part)
}

describe('sanitizeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['/etc/passwd', 'passwd'],
    ['..\\..\\win.ini', 'win.ini'],
    ['a/b/../c.txt', 'c.txt'],
    ['.bashrc', 'bashrc'],
    ['...hidden.txt', 'hidden.txt'],
    ['trailing dots...', 'trailing dots'],
    ['nul\u0000byte.txt', 'nul_byte.txt'],
    ['bidi‮txt.exe', 'bidi_txt.exe'],
    ['con.txt', '_con.txt'],
    ['LPT1', '_LPT1'],
    ['a<b>c:d.txt', 'a_b_c_d.txt'],
    ['é.txt', 'é.txt'],
  ])('%j becomes %j', (raw, expected) => {
    expect(sanitizeFileName(raw)).toBe(expected)
  })

  it.each(['', '.', '..', '   ', '.../', 'dir/', '???'])('rejects %j', (raw) => {
    expect(sanitizeFileName(raw)).toBeUndefined()
  })

  it('caps the name at 120 bytes, keeps the extension, and never splits a code point', () => {
    const name = sanitizeFileName(`${'é'.repeat(200)}.txt`)!
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(120)
    expect(name.endsWith('.txt')).toBe(true)
    expect(name).not.toContain('�')
    expect(Buffer.byteLength(numberedName(name, 12))).toBeLessThanOrEqual(120)
    expect(numberedName('a.png', 1)).toBe('a-1.png')
    expect(numberedName('Makefile', 2)).toBe('Makefile-2')
  })
})

describe('classifyUpload', () => {
  const allowed = [...DEFAULT_ALLOWED_MEDIA_TYPES]
  const classify = (name: string, head: Buffer, declaredType?: string) => classifyUpload({ head, name, declaredType, allowed })

  it('trusts magic bytes for rasters', () => {
    expect(sniffRaster(PNG)).toBe('image/png')
    expect(sniffRaster(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffRaster(Buffer.from('GIF89a......'))).toBe('image/gif')
    expect(sniffRaster(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffRaster(Buffer.from('<svg/>'))).toBeUndefined()
    expect(classify('x', PNG, 'image/png')).toBe('image/png')
    expect(classify('x.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpg')).toBe('image/jpeg')
  })

  it('refuses a raster that the name or declared type contradicts', () => {
    expect(() => classify('x.jpg', PNG)).toThrow(UploadRejection)
    expect(() => classify('x.png', PNG, 'image/gif')).toThrow(/not image\/gif/u)
  })

  it('refuses a raster type the deployment does not allow', () => {
    expect(() => classifyUpload({ head: PNG, name: 'x.png', declaredType: undefined, allowed: ['text/plain'] })).toThrow(/not accepted/u)
  })

  it('decides non-raster types by extension and checks the content', () => {
    expect(classify('a.md', Buffer.from('# hi'))).toBe('text/markdown')
    expect(classify('a.PY', Buffer.from('print(1)'))).toBe('text/plain')
    expect(classify('a.json', Buffer.from('{}'), 'text/plain')).toBe('application/json')
    expect(() => classify('a.json', Buffer.from([0x7b, 0x00]))).toThrow(UploadRejection)
    expect(() => classify('a.pdf', Buffer.from('%PDX-'))).toThrow(UploadRejection)
    expect(() => classify('a.png', Buffer.from('hello'))).toThrow(/not a valid image/u)
    expect(() => classify('a.txt', Buffer.from('hello'), 'image/png')).toThrow(/not a valid image/u)
  })

  it('reports an empty file as invalid and others as unsupported', () => {
    expect.assertions(2)
    try {
      classify('a.txt', Buffer.alloc(0))
    } catch (error: unknown) {
      expect(error).toMatchObject({ status: 400, code: 'invalid_file' })
    }
    try {
      classify('a.exe', Buffer.from('x'))
    } catch (error: unknown) {
      expect(error).toMatchObject({ status: 415, code: 'unsupported_media_type' })
    }
  })

  it('serves active types as octet-stream attachments and only rasters inline', () => {
    expect(servedType('image/png')).toEqual({ contentType: 'image/png', inline: true })
    expect(servedType('image/svg+xml')).toEqual({ contentType: 'application/octet-stream', inline: false })
    expect(servedType('text/html')).toEqual({ contentType: 'application/octet-stream', inline: false })
    expect(servedType('application/pdf')).toEqual({ contentType: 'application/pdf', inline: false })
  })
})

describe('filesystem FileStore', () => {
  it('stores, reads, streams, lists, and deletes', async () => {
    const store = createFilesystemFileStore(await tmp())
    await store.verify()
    const result = await store.put('alice/file_abc', chunks('hel', 'lo'), { maxBytes: 100 })
    expect(result).toEqual({ bytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' })
    expect((await store.get('alice/file_abc')).toString()).toBe('hello')
    const parts: Buffer[] = []
    for await (const part of await store.stream('alice/file_abc')) parts.push(part as Buffer)
    expect(Buffer.concat(parts).toString()).toBe('hello')
    expect((await store.list()).map(entry => entry.key)).toEqual(['alice/file_abc'])
    await store.delete('alice/file_abc')
    await store.delete('alice/file_abc')
    await expect(store.get('alice/file_abc')).rejects.toBeInstanceOf(FileNotFoundError)
    await expect(store.stream('alice/file_abc')).rejects.toBeInstanceOf(FileNotFoundError)
    expect(await store.list()).toEqual([])
  })

  it('leaves nothing behind when the source fails or exceeds the limit', async () => {
    const store = createFilesystemFileStore(await tmp())
    await expect(store.put('alice/file_big', chunks('12345', '6789'), { maxBytes: 6 })).rejects.toBeInstanceOf(FileTooLargeError)
    async function* broken() {
      yield Buffer.from('abc')
      throw new Error('client went away')
    }
    await expect(store.put('alice/file_broken', broken(), { maxBytes: 100 })).rejects.toThrow('client went away')
    expect(await store.list()).toEqual([])
  })

  it('rejects keys that could leave the directory', async () => {
    const dir = await tmp()
    const store = createFilesystemFileStore(dir)
    for (const key of ['../x/file_a', 'alice/../file_a', '/etc/passwd', 'alice/file_a/../../x', 'alice/notfile', 'alice\\file_a', '']) {
      await expect(store.put(key, chunks('x'), { maxBytes: 10 })).rejects.toThrow(/invalid file key/u)
      await expect(store.get(key)).rejects.toThrow(/invalid file key/u)
      await expect(store.delete(key)).rejects.toThrow(/invalid file key/u)
    }
    await writeFile(join(dir, 'stray.txt'), 'x')
    expect(await store.list()).toEqual([])
    expect(await readFile(join(dir, 'stray.txt'), 'utf8')).toBe('x')
  })

  it('fails verification loudly when the directory cannot be created', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'file'), 'x')
    await expect(createFilesystemFileStore(join(dir, 'file', 'staging')).verify()).rejects.toThrow()
  })
})

describe('uploads configuration', () => {
  const base = { auth: { mode: 'development', devKey: { key: 'k', owner: 'dev' } }, workspaces: '/tmp/agentry-w', database: { url: 'postgres://x' } }
  const uploads = (overrides: Partial<UploadsConfig> = {}): UploadsConfig => ({
    maxFileBytes: 100, maxFilesPerMessage: 2, maxMessageBytes: 200, maxStagedBytesPerOwner: 1000, stagedTtlMinutes: 10, sweepIntervalMinutes: 1, allowedMediaTypes: ['text/plain'], ...overrides,
  })

  it('defaults to 25 MiB per file, 10 files per message, and disabled uploads', () => {
    const resolved = Config(base as never)
    expect(resolved.uploads).toMatchObject({ maxFileBytes: 25 * 1024 * 1024, maxFilesPerMessage: 10, maxMessageBytes: 50 * 1024 * 1024, maxStagedBytesPerOwner: 500 * 1024 * 1024, stagedTtlMinutes: 1440 })
    expect(resolved.uploads.dir).toBeUndefined()
    expect(resolved.uploads.allowedMediaTypes).toContain('image/png')
    expect(stagingDirectory(resolved.uploads, resolved.workspaces)).toBeUndefined()
  })

  it('accepts overrides and fails loud on invalid values', () => {
    expect(Config({ ...base, uploads: { dir: '/tmp/agentry-staging', maxFileBytes: 5, maxMessageBytes: 5, maxStagedBytesPerOwner: 5 } } as never).uploads).toMatchObject({ dir: '/tmp/agentry-staging', maxFileBytes: 5 })
    for (const [uploadsBlock, message] of [
      [{ maxFileBytes: 0 }, /maxFileBytes/u],
      [{ maxFilesPerMessage: 1.5 }, /maxFilesPerMessage/u],
      [{ stagedTtlMinutes: -1 }, /stagedTtlMinutes/u],
      [{ sweepIntervalMinutes: 0 }, /sweepIntervalMinutes/u],
      [{ maxFileBytes: 100, maxMessageBytes: 50 }, /maxMessageBytes/u],
      [{ maxFileBytes: 100, maxStagedBytesPerOwner: 50 }, /maxStagedBytesPerOwner/u],
      [{ allowedMediaTypes: [] }, /allowedMediaTypes/u],
      [{ allowedMediaTypes: ['Text/Plain'] }, /malformed/u],
    ] as const) {
      expect(() => Config({ ...base, uploads: uploadsBlock } as never), JSON.stringify(uploadsBlock)).toThrow(message)
    }
    expect(() => validateUploads(uploads())).not.toThrow()
  })

  it('refuses a staging directory inside, or containing, the workspaces root', () => {
    expect(stagingDirectory(uploads({ dir: '/srv/staging' }), '/srv/workspaces')).toBe('/srv/staging')
    expect(() => stagingDirectory(uploads({ dir: '/srv/workspaces/staging' }), '/srv/workspaces')).toThrow(/separate directory/u)
    expect(() => stagingDirectory(uploads({ dir: '/srv' }), '/srv/workspaces')).toThrow(/separate directory/u)
    expect(() => stagingDirectory(uploads({ dir: '/srv/workspaces' }), '/srv/workspaces')).toThrow(/separate directory/u)
    expect(stagingDirectory(uploads({ dir: '   ' }), '/srv/workspaces')).toBeUndefined()
  })
})
