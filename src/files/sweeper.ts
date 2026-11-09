/**
 * Removes staged uploads that were never sent, and staging bytes that no staged row owns.
 */

import { directorySegment } from '../environment/local.ts'
import type { Store } from '../store/store.ts'
import { stagingKey, type FileStore } from './file-store.ts'

/** What one sweep removed. */
export interface SweepResult {
  /** Staged rows older than the TTL, with their bytes. */
  expired: number
  /** Objects older than the TTL whose row is missing or no longer `staged` (crashed uploads, failed post-send deletes, incomplete writes). */
  orphans: number
}

/** Inputs of one sweep. */
export interface SweepDeps {
  store: Store
  staging: FileStore
  /** Age, in milliseconds, after which a staged file is removed. */
  ttlMs: number
  /** Clock in epoch milliseconds, injectable in tests. */
  now?: () => number
  warn: (message: string) => void
}

/** Matches the incomplete-write suffix of a staging key. */
const PARTIAL = /\.[a-f0-9]+\.part$/u

/**
 * Run one sweep. An object younger than the TTL is never an orphan: an upload writes its bytes before it inserts
 * its row, so a fresh object without a row may be in flight.
 * @param deps - store, staging bytes, TTL, and logger.
 * @returns how many rows and objects were removed.
 */
export async function sweepFiles(deps: SweepDeps): Promise<SweepResult> {
  const cutoff = (deps.now ?? Date.now)() - deps.ttlMs
  const remove = async (key: string): Promise<boolean> => {
    try {
      await deps.staging.delete(key)
      return true
    } catch (error: unknown) {
      deps.warn(`agents-api: sweep could not remove ${key}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  let expired = 0
  for (const row of await deps.store.files.expireStaged(new Date(cutoff))) {
    if (await remove(stagingKey(directorySegment(row.ownerId, 'owner'), row.id))) expired += 1
  }
  const old = (await deps.staging.list()).filter(entry => entry.modifiedMs < cutoff)
  const idOf = (key: string): string => (key.split('/')[1] ?? '').replace(PARTIAL, '')
  const staged = await deps.store.files.stagedIds(old.map(entry => idOf(entry.key)))
  let orphans = 0
  for (const entry of old) {
    if (!PARTIAL.test(entry.key) && staged.has(idOf(entry.key))) continue
    if (await remove(entry.key)) orphans += 1
  }
  return { expired, orphans }
}

/** Options of `startSweeper`. */
export interface SweeperOptions extends Omit<SweepDeps, 'store'> {
  /** The attached store, or `undefined` while there is none (a sweep is skipped). */
  store: () => Store | undefined
  /** Milliseconds between sweeps. */
  intervalMs: number
}

/**
 * Sweep now and then every `intervalMs`. Sweeps never overlap and never throw: a failure is logged and the next
 * interval tries again.
 * @param options - dependencies and timing.
 * @returns a disposer that stops the timer and waits for a sweep in flight.
 */
export function startSweeper(options: SweeperOptions): () => Promise<void> {
  let running: Promise<void> | undefined
  const run = (): void => {
    const store = options.store()
    if (running !== undefined || store === undefined) return
    running = sweepFiles({ ...options, store })
      .then((result) => {
        if (result.expired + result.orphans > 0) options.warn(`agents-api: upload sweep removed ${String(result.expired)} expired and ${String(result.orphans)} orphaned files`)
      })
      .catch((error: unknown) => {
        options.warn(`agents-api: upload sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        running = undefined
      })
  }
  run()
  const timer = setInterval(run, options.intervalMs)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await running
  }
}
