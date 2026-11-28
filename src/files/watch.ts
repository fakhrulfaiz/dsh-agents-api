/**
 * Shared workspace file watches: one upstream watch per session, debounced change
 * batches fanned out to SSE subscribers. The upstream source owns the real watch
 * (envd WatchDir or local fs.watch); this hub only manages sharing and limits.
 */

export type WatchEvent =
  | { type: 'changed'; paths: string[] }
  | { type: 'reset' }
  | { type: 'closed' }

export class WatchLimitError extends Error {
  readonly status = 429
  readonly code = 'too_many_watches'

  constructor() {
    super('Too many watched sessions')
    this.name = 'WatchLimitError'
  }
}

interface SessionWatch {
  owner: string
  sessionId: string
  source: (signal: AbortSignal) => AsyncIterable<string[]>
  controller: AbortController
  subscribers: Set<(event: WatchEvent) => void>
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | undefined
  idleTimer: ReturnType<typeof setTimeout> | undefined
  started: boolean
  closed: boolean
}

export class WatchHub {
  private readonly sessions = new Map<string, SessionWatch>()

  constructor(
    private readonly idleMs = 30_000,
    private readonly debounceMs = 500,
    private readonly maxPaths = 200,
    private readonly maxPerOwner = 8,
  ) {}

  subscribe(
    owner: string,
    sessionId: string,
    source: (signal: AbortSignal) => AsyncIterable<string[]>,
    onEvent: (event: WatchEvent) => void,
  ): () => void {
    let entry = this.sessions.get(sessionId)
    if (entry === undefined) {
      if (this.countForOwner(owner) >= this.maxPerOwner) throw new WatchLimitError()
      entry = {
        owner,
        sessionId,
        source,
        controller: new AbortController(),
        subscribers: new Set(),
        pending: new Set(),
        timer: undefined,
        idleTimer: undefined,
        started: false,
        closed: false,
      }
      this.sessions.set(sessionId, entry)
    }

    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    entry.subscribers.add(onEvent)
    if (!entry.started) {
      entry.started = true
      void this.run(entry)
    }

    return () => {
      const current = this.sessions.get(sessionId)
      if (current === undefined) return
      current.subscribers.delete(onEvent)
      if (current.subscribers.size === 0 && current.idleTimer === undefined) {
        current.idleTimer = setTimeout(() => this.stop(sessionId), this.idleMs)
      }
    }
  }

  private countForOwner(owner: string): number {
    let n = 0
    for (const entry of this.sessions.values()) if (entry.owner === owner) n += 1
    return n
  }

  private emit(entry: SessionWatch, event: WatchEvent): void {
    for (const sub of [...entry.subscribers]) sub(event)
  }

  private flush(entry: SessionWatch): void {
    entry.timer = undefined
    if (entry.pending.size === 0) return
    const paths = [...entry.pending]
    entry.pending.clear()
    if (paths.length > this.maxPaths) {
      this.emit(entry, { type: 'reset' })
      return
    }
    this.emit(entry, { type: 'changed', paths })
  }

  private schedule(entry: SessionWatch): void {
    if (entry.timer !== undefined) return
    entry.timer = setTimeout(() => this.flush(entry), this.debounceMs)
  }

  private stop(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    this.sessions.delete(sessionId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.controller.abort()
  }

  private async run(entry: SessionWatch): Promise<void> {
    try {
      for await (const batch of entry.source(entry.controller.signal)) {
        if (entry.controller.signal.aborted) return
        for (const path of batch) entry.pending.add(path)
        if (entry.pending.size > this.maxPaths) {
          if (entry.timer !== undefined) {
            clearTimeout(entry.timer)
            entry.timer = undefined
          }
          entry.pending.clear()
          this.emit(entry, { type: 'reset' })
          continue
        }
        this.schedule(entry)
      }
      if (entry.controller.signal.aborted) return
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
        this.flush(entry)
      } else if (entry.pending.size > 0) {
        this.flush(entry)
      }
      if (!entry.closed) {
        entry.closed = true
        this.emit(entry, { type: 'closed' })
      }
    } catch {
      if (entry.controller.signal.aborted) return
      if (!entry.closed) {
        entry.closed = true
        this.emit(entry, { type: 'closed' })
      }
    } finally {
      if (this.sessions.get(entry.sessionId) === entry) this.stop(entry.sessionId)
    }
  }
}
