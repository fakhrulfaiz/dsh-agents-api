/**
 * Byte storage for staged uploads behind a small interface. Only a filesystem
 * implementation exists; an S3 or SeaweedFS implementation can replace it
 * later without touching callers. After a file is attached, its durable copy
 * lives in the DSH attachment store, not here.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** `put` received more than `maxBytes`; nothing is stored. */
export class FileTooLargeError extends Error {
  /** @param maxBytes - the limit that was exceeded. */
  constructor(readonly maxBytes: number) {
    super(`file exceeds ${String(maxBytes)} bytes`)
    this.name = 'FileTooLargeError'
  }
}

/** `get` or `stream` named a key that holds no bytes. */
export class FileNotFoundError extends Error {
  /** @param key - the missing key. */
  constructor(readonly key: string) {
    super(`no stored bytes for ${key}`)
    this.name = 'FileNotFoundError'
  }
}

/** One stored object as `FileStore.list` reports it. */
export interface StoredFileInfo {
  key: string
  /** Last modification time, epoch milliseconds. */
  modifiedMs: number
}

/** Result of `FileStore.put`. */
export interface PutResult {
  /** Exact number of bytes stored. */
  bytes: number
  /** Hex sha256 of the stored bytes. */
  sha256: string
}

/**
 * Staged-upload bytes. Keys are `<owner-segment>/<file id>`; callers build
 * them from validated ids, and implementations reject anything else.
 */
export interface FileStore {
  /**
   * Create the backing location and prove it is writable.
   * @throws when the location cannot be created or written; callers treat this as a configuration error.
   */
  verify(): Promise<void>
  /**
   * Store bytes under `key`. The object becomes visible only when complete: a failed, oversized, or aborted
   * source leaves nothing behind.
   * @param key - storage key.
   * @param source - ordered chunks; an error thrown by the source aborts the write and is rethrown.
   * @param options - `maxBytes` is the largest accepted size.
   * @returns exact size and sha256.
   * @throws FileTooLargeError when the source yields more than `maxBytes`.
   */
  put(key: string, source: AsyncIterable<Uint8Array>, options: { maxBytes: number }): Promise<PutResult>
  /**
   * @param key - storage key.
   * @returns all bytes of the object.
   * @throws FileNotFoundError when the key holds nothing.
   */
  get(key: string): Promise<Buffer>
  /**
   * @param key - storage key.
   * @returns a stream of the object's bytes.
   * @throws FileNotFoundError when the key holds nothing (thrown here, before any byte is read).
   */
  stream(key: string): Promise<Readable>
  /**
   * Remove an object. A missing key is success.
   * @param key - storage key.
   */
  delete(key: string): Promise<void>
  /**
   * @returns every object, including incomplete writes, for orphan cleanup.
   */
  list(): Promise<StoredFileInfo[]>
}

/** Key shape: owner directory segment, then a file id optionally followed by an incomplete-write suffix. */
const KEY = /^[A-Za-z0-9_@.-]+\/file_[A-Za-z0-9]+(\.[a-f0-9]+\.part)?$/u

/**
 * @param owner - owner directory segment, already validated by `directorySegment`.
 * @param fileId - `file_<random>` id.
 * @returns the storage key of a staged file.
 */
export function stagingKey(owner: string, fileId: string): string {
  return `${owner}/${fileId}`
}

/**
 * `FileStore` over a directory: `<root>/<owner-segment>/<file id>`. Directories are mode 0700 and files 0600.
 * @param root - absolute staging directory; must lie outside the session workspaces.
 * @returns the store.
 */
export function createFilesystemFileStore(root: string): FileStore {
  const base = resolve(root)

  /** Absolute path of a validated key. */
  function pathOf(key: string): string {
    const path = resolve(base, key)
    if (!KEY.test(key) || key.includes('..') || !path.startsWith(base + sep)) throw new Error(`invalid file key "${key}"`)
    return path
  }

  return {
    async verify() {
      await mkdir(base, { recursive: true, mode: 0o700 })
      const probe = join(base, `.probe-${randomBytes(6).toString('hex')}`)
      await writeFile(probe, 'ok', { flag: 'wx', mode: 0o600 })
      await rm(probe)
    },
    async put(key, source, options) {
      const path = pathOf(key)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const partial = `${path}.${randomBytes(6).toString('hex')}.part`
      const hash = createHash('sha256')
      let bytes = 0
      async function* counted(): AsyncGenerator<Uint8Array> {
        for await (const chunk of source) {
          bytes += chunk.byteLength
          if (bytes > options.maxBytes) throw new FileTooLargeError(options.maxBytes)
          hash.update(chunk)
          yield chunk
        }
      }
      try {
        await pipeline(Readable.from(counted(), { objectMode: false }), createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
        await rename(partial, path)
      } catch (error: unknown) {
        await rm(partial, { force: true })
        throw error
      }
      return { bytes, sha256: hash.digest('hex') }
    },
    async get(key) {
      try {
        return await readFile(pathOf(key))
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFoundError(key)
        throw error
      }
    },
    async stream(key) {
      const path = pathOf(key)
      try {
        await stat(path)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFoundError(key)
        throw error
      }
      return createReadStream(path)
    },
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
    async list() {
      const found: StoredFileInfo[] = []
      let owners: string[]
      try {
        owners = await readdir(base)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found
        throw error
      }
      for (const owner of owners) {
        let names: string[]
        try {
          names = await readdir(join(base, owner))
        } catch (error: unknown) {
          // Not a directory (for example a probe file): not an object.
          if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') continue
          throw error
        }
        for (const name of names) {
          const key = `${owner}/${name}`
          if (!KEY.test(key)) continue
          found.push({ key, modifiedMs: (await stat(join(base, key))).mtimeMs })
        }
      }
      return found
    },
  }
}
