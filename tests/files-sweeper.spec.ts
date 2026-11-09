import { mkdtemp, rm, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownerId } from '../src/auth/authenticator.ts'
import { createFilesystemFileStore } from '../src/files/file-store.ts'
import { startSweeper, sweepFiles } from '../src/files/sweeper.ts'
import type { FileRow } from '../src/store/store.ts'
import { MemoryStore } from './support/memory-store.ts'

const HOUR = 3_600_000
const A = ownerId('alice')
const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'agentry-sweep-'))
  dirs.push(dir)
  const staging = createFilesystemFileStore(dir)
  const store = new MemoryStore()
  await store.ensureOwner(A)
  const warn = vi.fn()
  /** Stage a file: bytes, then the row, aged by `ageMs`. */
  async function stage(id: string, ageMs: number, options: { row?: boolean; status?: 'staged' | 'attached' } = {}): Promise<void> {
    await staging.put(`alice/${id}`, (async function* () { yield Buffer.from('x') })(), { maxBytes: 10 })
    const when = new Date(Date.now() - ageMs)
    await utimes(join(dir, 'alice', id), when, when)
    if (options.row === false) return
    const row: FileRow = { id, ownerId: A, name: 'a.txt', mediaType: 'text/plain', bytes: 1, sha256: 'a'.repeat(64), status: 'staged', sessionId: null, attachment: null, workspacePath: null, createdAt: when, attachedAt: null }
    await store.files.insert(row)
    if (options.status === 'attached') await store.files.claim(A, [id], 'sess_1')
  }
  return { dir, staging, store, warn, stage }
}

describe('sweepFiles', () => {
  it('removes staged rows and bytes older than the TTL and keeps newer ones', async () => {
    const { staging, store, warn, stage } = await setup()
    await stage('file_old', 25 * HOUR)
    await stage('file_new', HOUR)
    const result = await sweepFiles({ store, staging, ttlMs: 24 * HOUR, warn })
    expect(result).toEqual({ expired: 1, orphans: 0 })
    expect(await store.files.get('file_old', A)).toBeUndefined()
    expect(await store.files.get('file_new', A)).toBeDefined()
    expect((await staging.list()).map(entry => entry.key)).toEqual(['alice/file_new'])
  })

  it('never touches an attached row, even an old one', async () => {
    const { store, staging, warn, stage } = await setup()
    await stage('file_att', 48 * HOUR, { status: 'attached' })
    await staging.delete('alice/file_att')
    await sweepFiles({ store, staging, ttlMs: 24 * HOUR, warn })
    expect(await store.files.get('file_att', A)).toMatchObject({ status: 'attached' })
  })

  it('removes old bytes with no row or a row that is no longer staged, and keeps fresh in-flight bytes', async () => {
    const { store, staging, warn, stage } = await setup()
    await stage('file_crashed', 30 * HOUR, { row: false })
    await stage('file_sent', 30 * HOUR, { status: 'attached' })
    await stage('file_inflight', 1000, { row: false })
    const result = await sweepFiles({ store, staging, ttlMs: 24 * HOUR, warn })
    expect(result).toEqual({ expired: 0, orphans: 2 })
    expect((await staging.list()).map(entry => entry.key)).toEqual(['alice/file_inflight'])
  })

  it('removes stale incomplete writes', async () => {
    const { dir, store, staging, warn } = await setup()
    await mkdir(join(dir, 'alice'), { recursive: true })
    const partial = join(dir, 'alice', 'file_x.abc123.part')
    await writeFile(partial, 'x')
    const old = new Date(Date.now() - 30 * HOUR)
    await utimes(partial, old, old)
    expect((await sweepFiles({ store, staging, ttlMs: 24 * HOUR, warn })).orphans).toBe(1)
    expect(await staging.list()).toEqual([])
  })

  it('uses the injected clock', async () => {
    const { store, staging, warn, stage } = await setup()
    await stage('file_a', 1000)
    expect((await sweepFiles({ store, staging, ttlMs: HOUR, warn, now: () => Date.now() + 2 * HOUR })).expired).toBe(1)
  })
})

describe('startSweeper', () => {
  it('sweeps at start and every interval, never overlaps, and stops on dispose', async () => {
    vi.useFakeTimers()
    const calls = vi.fn(() => undefined)
    const store = new MemoryStore()
    const spy = vi.spyOn(store.files, 'expireStaged').mockImplementation(async () => {
      calls()
      return []
    })
    const staging = { list: async () => [], delete: async () => undefined } as never
    const dispose = startSweeper({ store: () => store, staging, ttlMs: HOUR, intervalMs: 1000, warn: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    expect(spy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2500)
    expect(spy).toHaveBeenCalledTimes(3)
    await dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('skips a sweep while there is no store and logs a failing sweep instead of throwing', async () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const store = new MemoryStore()
    vi.spyOn(store.files, 'expireStaged').mockRejectedValue(new Error('db down'))
    let attached: MemoryStore | undefined
    const staging = { list: async () => [], delete: async () => undefined } as never
    const dispose = startSweeper({ store: () => attached, staging, ttlMs: HOUR, intervalMs: 1000, warn })
    await vi.advanceTimersByTimeAsync(1000)
    expect(warn).not.toHaveBeenCalled()
    attached = store
    await vi.advanceTimersByTimeAsync(1000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('upload sweep failed: db down'))
    await dispose()
  })
})
