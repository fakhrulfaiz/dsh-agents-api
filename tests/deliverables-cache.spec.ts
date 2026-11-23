/** Per-session deliverables cache: reuse until the session changes. */

import { describe, expect, it, vi } from 'vitest'
import { DeliverablesCache } from '../src/history/deliverables-cache.ts'

describe('DeliverablesCache', () => {
  it('loads once per version and again when the version changes', async () => {
    const cache = new DeliverablesCache(10)
    const load = vi.fn(async () => [{ path: 'a.md' }])
    await cache.get('s1', 'v1', load)
    await cache.get('s1', 'v1', load)
    expect(load).toHaveBeenCalledTimes(1)
    await cache.get('s1', 'v2', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never caches without a version (a running session)', async () => {
    const cache = new DeliverablesCache(10)
    const load = vi.fn(async () => [])
    await cache.get('s1', undefined, load)
    await cache.get('s1', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest entry past its capacity, and does not cache failures', async () => {
    const cache = new DeliverablesCache(2)
    const load = vi.fn(async () => [])
    for (const id of ['a', 'b', 'c']) await cache.get(id, 'v', load)
    await cache.get('a', 'v', load)
    expect(load).toHaveBeenCalledTimes(4)
    const failing = vi.fn(async () => { throw new Error('boom') })
    await expect(cache.get('x', 'v', failing)).rejects.toThrow('boom')
    await expect(cache.get('x', 'v', failing)).rejects.toThrow('boom')
    expect(failing).toHaveBeenCalledTimes(2)
  })
})
