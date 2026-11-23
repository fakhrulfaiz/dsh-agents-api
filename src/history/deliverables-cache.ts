/**
 * Deliverables read from a Session log are fixed until the session changes,
 * so they are kept per session under a version (the index row's update time
 * and status) and read again only when it moves. A running session passes no
 * version and is always read. Least recently used entries go past capacity.
 */

export class DeliverablesCache<T = unknown> {
  readonly #entries = new Map<string, { version: string; value: T[] }>()

  /** @param capacity - most sessions kept. */
  constructor(private readonly capacity: number) {}

  /**
   * @param sessionId - session.
   * @param version - changes whenever the session may have new deliverables; `undefined` skips the cache.
   * @param load - reads the deliverables; a rejection is not cached.
   * @returns the deliverables.
   */
  async get(sessionId: string, version: string | undefined, load: () => Promise<T[]>): Promise<T[]> {
    if (version === undefined) return load()
    const hit = this.#entries.get(sessionId)
    if (hit !== undefined && hit.version === version) {
      this.#entries.delete(sessionId)
      this.#entries.set(sessionId, hit)
      return hit.value
    }
    const value = await load()
    this.#entries.delete(sessionId)
    this.#entries.set(sessionId, { version, value })
    while (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    return value
  }
}
