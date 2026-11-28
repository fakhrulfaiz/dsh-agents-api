import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { watchLocalDir } from '../src/files/local-watch.ts'
import { normalizeSandboxWatchPath } from '../src/sandbox/agentry-sandbox-provider.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentry-watch-'))
  dirs.push(dir)
  return dir
}

async function nextBatch(iter: AsyncIterator<string[]>, timeoutMs = 5000): Promise<string[]> {
  return await Promise.race([
    iter.next().then((r) => (r.done ? [] : r.value)),
    new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for watch batch')), timeoutMs)),
  ])
}

describe('normalizeSandboxWatchPath', () => {
  it('normalizes absolute and relative names inside the workspace', () => {
    expect(normalizeSandboxWatchPath('/workspace', '/workspace/src/a.ts')).toBe('src/a.ts')
    expect(normalizeSandboxWatchPath('/workspace', 'src/a.ts')).toBe('src/a.ts')
  })

  it('ignores skipped dirs and escapes', () => {
    expect(normalizeSandboxWatchPath('/workspace', '/workspace/node_modules/pkg/index.js')).toBeUndefined()
    expect(normalizeSandboxWatchPath('/workspace', '/workspace/.git/config')).toBeUndefined()
    expect(normalizeSandboxWatchPath('/workspace', '/etc/passwd')).toBeUndefined()
    expect(normalizeSandboxWatchPath('/workspace', '/workspace')).toBeUndefined()
  })
})

describe('watchLocalDir', () => {
  it('yields changed relative paths and ignores skipped dirs', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, 'node_modules/pkg'), { recursive: true })
    const ac = new AbortController()
    const iter = watchLocalDir(dir, ac.signal)[Symbol.asyncIterator]()
    try {
      // Start consuming before writing; fs.promises.watch only delivers events while iterated.
      const first = nextBatch(iter, 5000)
      await new Promise((r) => setTimeout(r, 150))
      await writeFile(join(dir, 'src/a.txt'), 'hello')
      const batches: string[] = []
      batches.push(...await first)
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !batches.includes('src/a.txt')) {
        batches.push(...await nextBatch(iter, 2000))
      }
      expect(batches).toContain('src/a.txt')

      await writeFile(join(dir, 'node_modules/pkg/index.js'), 'nope')
      // Drain briefly; skipped paths must not appear.
      const extra: string[] = []
      const drainUntil = Date.now() + 600
      while (Date.now() < drainUntil) {
        try { extra.push(...await nextBatch(iter, 200)) } catch { break }
      }
      expect(extra.some((p) => p.includes('node_modules'))).toBe(false)
    } finally {
      ac.abort()
      await iter.return?.()
    }
  })
})
