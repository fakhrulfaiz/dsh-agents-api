import { watch } from 'node:fs/promises'
import path from 'node:path'

const SKIP = new Set(['.git', 'node_modules', '__pycache__'])

/** Watch a local workspace directory recursively, yielding changed workspace-relative paths. */
export async function* watchLocalDir(dir: string, signal: AbortSignal): AsyncIterable<string[]> {
  try {
    const watcher = watch(dir, { recursive: true, signal })
    for await (const event of watcher) {
      if (signal.aborted) return
      const raw = event.filename
      if (raw === null || raw === undefined) continue
      const name = typeof raw === 'string' ? raw : raw.toString()
      const rel = name.split(path.sep).join('/').replace(/^\/+/, '')
      if (!rel || rel === '.' || rel.startsWith('..')) continue
      if (rel.split('/').some((seg) => SKIP.has(seg))) continue
      yield [rel]
    }
  } catch (error) {
    if (signal.aborted) return
    if ((error as NodeJS.ErrnoException).name === 'AbortError') return
    throw error
  }
}
