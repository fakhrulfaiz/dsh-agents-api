/**
 * The live view of a sandbox chat's browser: one relay per session (see
 * `browser-live-relay.ts`), started inside the sandbox through envd for the
 * first reader, shared by every reader of that session, and stopped a while
 * after the last one leaves. A new reader first gets the last frame (or
 * `idle`). Frames are capped at one per `minIntervalMs`, keeping the newest.
 * The relay is read-only, and no address into the sandbox ever leaves the API.
 */
import { EnvdProcessStream } from './remote/envd-stream.ts'
import { BROWSER_LIVE_RELAY_SCRIPT, RELAY_ENV } from './browser-live-relay.ts'
import type { EnvdClient } from '@agentry/sandbox/client'

export type LiveFrame = { kind: 'frame'; data: string; url: string; title: string; width?: number; height?: number; ts: number }
/**
 * Why no frames come: `not_started` (no browser open yet, or the sandbox is not running), `no_browser` (the
 * sandbox image has no browser), `browser_off` (the agent's Web browser switch is off), `not_sandbox` (the chat
 * does not run in a sandbox). The last two are decided by the route, never by the relay.
 */
export type IdleReason = 'not_started' | 'no_browser' | 'browser_off' | 'not_sandbox'
export type LiveIdle = { kind: 'idle'; reason: IdleReason }
/** `closed`: the view ended (its environment stopped); the reader should end its stream. */
export type LiveEvent = LiveFrame | LiveIdle | { kind: 'closed' }

/** The part of `EnvdProcessStream` the hub uses. */
export interface RelayProcess extends NodeJS.ReadableStream {
  readonly exited: Promise<number | null>
  ready(): Promise<number>
  end(): unknown
  kill(force?: boolean): Promise<void>
}

export class BrowserLiveError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
  }
}

export interface LiveKey {
  owner: string
  sessionId: string
  environmentId: string
}

interface View extends LiveKey {
  readers: Set<(event: LiveEvent) => void>
  start: () => RelayProcess
  relay: RelayProcess | undefined
  last: LiveFrame | LiveIdle | undefined
  lastSentAt: number
  pending: LiveFrame | undefined
  flushTimer: NodeJS.Timeout | undefined
  stopTimer: NodeJS.Timeout | undefined
  restartTimer: NodeJS.Timeout | undefined
  restartDelay: number
}

export interface BrowserLiveOptions {
  /** Least time between two frames sent to readers (default 250 ms: 4 frames a second). */
  minIntervalMs?: number
  /** How long a relay runs on with no reader (default 10 s). */
  stopAfterMs?: number
  /** First wait before restarting a relay that ended while readers remain; doubles to 30 s. */
  restartMs?: number
  /** Live views one owner may have at once (default 4). */
  maxPerOwner?: number
}

const MAX_RESTART_MS = 30_000
const NOT_STARTED: LiveIdle = { kind: 'idle', reason: 'not_started' }

/** One frame every `ms`, as the relay's environment. */
export function relayEnv(port: number, intervalMs: number): Record<string, string> {
  return { [RELAY_ENV.port]: String(port), [RELAY_ENV.intervalMs]: String(intervalMs), [RELAY_ENV.quality]: '60', [RELAY_ENV.maxWidth]: '1280', [RELAY_ENV.maxHeight]: '960' }
}

/** Starts the relay as `agent` in the sandbox behind `envd`, watching the browser on `port`. */
export function startRelay(envd: EnvdClient, port: number, intervalMs: number): RelayProcess {
  return new EnvdProcessStream(envd, { cmd: 'node', args: ['-e', BROWSER_LIVE_RELAY_SCRIPT], user: 'agent', env: relayEnv(port, intervalMs) })
}

/** Parses one relay line; undefined for anything that is not a frame or idle. */
export function parseRelayLine(line: string): LiveFrame | LiveIdle | undefined {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return undefined
  }
  if (msg === null || typeof msg !== 'object') return undefined
  const m = msg as Record<string, unknown>
  if (m['type'] === 'idle') return { kind: 'idle', reason: m['reason'] === 'no_browser' ? 'no_browser' : 'not_started' }
  if (m['type'] !== 'frame' || typeof m['data'] !== 'string' || m['data'] === '') return undefined
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const width = num(m['width'])
  const height = num(m['height'])
  return {
    kind: 'frame',
    data: m['data'],
    url: typeof m['url'] === 'string' ? m['url'] : '',
    title: typeof m['title'] === 'string' ? m['title'] : '',
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ts: num(m['ts']) ?? Date.now(),
  }
}

export class BrowserLiveHub {
  private readonly views = new Map<string, View>()
  private readonly minIntervalMs: number
  private readonly stopAfterMs: number
  private readonly restartMs: number
  private readonly maxPerOwner: number

  constructor(options: BrowserLiveOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 250
    this.stopAfterMs = options.stopAfterMs ?? 10_000
    this.restartMs = options.restartMs ?? 2_000
    this.maxPerOwner = options.maxPerOwner ?? 4
  }

  /** The least time between frames, also handed to the relay so Chromium sends no more. */
  get intervalMs(): number {
    return this.minIntervalMs
  }

  /**
   * Adds a reader of `key`'s live view, starting its relay with `start` when none runs.
   * @returns the detach function.
   * @throws BrowserLiveError 429 when the owner already has `maxPerOwner` views.
   */
  attach(key: LiveKey, start: () => RelayProcess, onEvent: (event: LiveEvent) => void): () => void {
    let view = this.views.get(key.sessionId)
    if (view !== undefined && view.owner !== key.owner) throw new BrowserLiveError('session not found', 404, 'not_found')
    if (view === undefined) {
      if ([...this.views.values()].filter(v => v.owner === key.owner).length >= this.maxPerOwner) {
        throw new BrowserLiveError(`at most ${String(this.maxPerOwner)} live browser views can be open; close one first`, 429, 'too_many_live_views')
      }
      view = {
        ...key, readers: new Set(), start, relay: undefined, last: undefined, lastSentAt: 0, pending: undefined,
        flushTimer: undefined, stopTimer: undefined, restartTimer: undefined, restartDelay: this.restartMs,
      }
      this.views.set(key.sessionId, view)
    }
    if (view.last !== undefined) onEvent(view.last)
    view.readers.add(onEvent)
    if (view.stopTimer !== undefined) {
      clearTimeout(view.stopTimer)
      view.stopTimer = undefined
    }
    if (view.relay === undefined && view.restartTimer === undefined) this.run(view)
    const current = view
    return () => {
      current.readers.delete(onEvent)
      if (current.readers.size === 0 && this.views.get(current.sessionId) === current) {
        current.stopTimer = setTimeout(() => { this.dispose(current) }, this.stopAfterMs)
        current.stopTimer.unref?.()
      }
    }
  }

  private run(view: View): void {
    let relay: RelayProcess
    try {
      relay = view.start()
    } catch {
      this.relayEnded(view)
      return
    }
    view.relay = relay
    relay.ready().catch(() => {})
    let buffer = ''
    relay.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString()
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const event = parseRelayLine(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        if (event !== undefined && view.relay === relay) this.receive(view, event)
      }
    })
    relay.on('error', () => {})
    void relay.exited.then(() => {
      if (view.relay !== relay) return
      view.relay = undefined
      this.relayEnded(view)
    })
  }

  private relayEnded(view: View): void {
    if (this.views.get(view.sessionId) !== view) return
    this.receive(view, NOT_STARTED)
    if (view.readers.size === 0) return
    view.restartTimer = setTimeout(() => {
      view.restartTimer = undefined
      if (this.views.get(view.sessionId) === view && view.relay === undefined) this.run(view)
    }, view.restartDelay)
    view.restartTimer.unref?.()
    view.restartDelay = Math.min(MAX_RESTART_MS, view.restartDelay * 2)
  }

  private receive(view: View, event: LiveFrame | LiveIdle): void {
    if (event.kind === 'idle') {
      view.pending = undefined
      if (view.last?.kind === 'idle' && view.last.reason === event.reason) return
      view.last = event
      this.emit(view, event)
      return
    }
    view.restartDelay = this.restartMs
    const wait = view.lastSentAt + this.minIntervalMs - Date.now()
    if (wait <= 0 && view.flushTimer === undefined) {
      this.sendFrame(view, event)
      return
    }
    view.pending = event
    view.flushTimer ??= setTimeout(() => {
      view.flushTimer = undefined
      const next = view.pending
      view.pending = undefined
      if (next !== undefined) this.sendFrame(view, next)
    }, Math.max(0, wait))
  }

  private sendFrame(view: View, frame: LiveFrame): void {
    view.lastSentAt = Date.now()
    view.last = frame
    this.emit(view, frame)
  }

  private emit(view: View, event: LiveEvent): void {
    for (const reader of [...view.readers]) reader(event)
  }

  private dispose(view: View, notify = false): void {
    if (this.views.get(view.sessionId) === view) this.views.delete(view.sessionId)
    for (const timer of [view.flushTimer, view.stopTimer, view.restartTimer]) if (timer !== undefined) clearTimeout(timer)
    const relay = view.relay
    view.relay = undefined
    if (relay !== undefined) {
      relay.end()
      void relay.kill().catch(() => {})
    }
    if (notify) {
      if (view.last?.kind !== 'idle') this.emit(view, NOT_STARTED)
      this.emit(view, { kind: 'closed' })
    }
    view.readers.clear()
  }

  /** Ends the views of an environment that was stopped, reset or deleted. */
  closeEnvironment(environmentId: string): void {
    for (const view of [...this.views.values()]) if (view.environmentId === environmentId) this.dispose(view, true)
  }

  stop(): void {
    for (const view of [...this.views.values()]) this.dispose(view, true)
  }
}
