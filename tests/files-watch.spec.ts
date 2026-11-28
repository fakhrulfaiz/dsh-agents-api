import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchHub, WatchLimitError, type WatchEvent } from '../src/files/watch.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeSource(batches: string[][], opts?: { end?: boolean; hangAfter?: number }) {
  const aborted = deferred()
  const source = (signal: AbortSignal): AsyncIterable<string[]> => ({
    async *[Symbol.asyncIterator]() {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      let i = 0
      for (const batch of batches) {
        if (signal.aborted) return
        yield batch
        i += 1
        if (opts?.hangAfter !== undefined && i >= opts.hangAfter) {
          await aborted.promise
          return
        }
      }
      if (opts?.end) return
      await aborted.promise
    },
  })
  return { source, aborted }
}

describe('WatchHub', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('merges rapid batches into one changed event with deduped paths', async () => {
    const hub = new WatchHub(30_000, 500, 200, 8)
    const events: WatchEvent[] = []
    const { source } = makeSource([['a.txt', 'b.txt'], ['b.txt', 'c.txt']], { hangAfter: 2 })
    const unsub = hub.subscribe('alice', 's1', source, (e) => events.push(e))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([{ type: 'changed', paths: ['a.txt', 'b.txt', 'c.txt'] }])
    unsub()
  })

  it('emits reset when a batch contains more than maxPaths', async () => {
    const hub = new WatchHub(30_000, 500, 200, 8)
    const events: WatchEvent[] = []
    const paths = Array.from({ length: 201 }, (_, i) => `f${String(i)}.txt`)
    const { source } = makeSource([paths], { hangAfter: 1 })
    const unsub = hub.subscribe('alice', 's1', source, (e) => events.push(e))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([{ type: 'reset' }])
    unsub()
  })

  it('aborts the source 30s after the last subscriber leaves', async () => {
    const hub = new WatchHub(30_000, 500, 200, 8)
    let signal: AbortSignal | undefined
    const source = (s: AbortSignal): AsyncIterable<string[]> => ({
      async *[Symbol.asyncIterator]() {
        signal = s
        await new Promise<void>((resolve) => s.addEventListener('abort', () => resolve(), { once: true }))
      },
    })
    const unsub = hub.subscribe('alice', 's1', source, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(signal?.aborted).toBe(false)
    unsub()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
  })

  it('rejects a 9th watched session for the same owner', async () => {
    const hub = new WatchHub(30_000, 500, 200, 8)
    const unsubs: Array<() => void> = []
    for (let i = 0; i < 8; i += 1) {
      const { source } = makeSource([], {})
      unsubs.push(hub.subscribe('alice', `s${String(i)}`, source, () => {}))
    }
    const { source } = makeSource([], {})
    expect(() => hub.subscribe('alice', 's8', source, () => {})).toThrow(WatchLimitError)
    for (const u of unsubs) u()
  })

  it('emits closed when the source ends', async () => {
    const hub = new WatchHub(30_000, 500, 200, 8)
    const events: WatchEvent[] = []
    const { source } = makeSource([], { end: true })
    const unsub = hub.subscribe('alice', 's1', source, (e) => events.push(e))
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual([{ type: 'closed' }])
    unsub()
  })
})
