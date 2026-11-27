/**
 * The live view of a sandbox chat's browser: one relay per session (see
 * `browser-live-relay.ts`), started inside the sandbox through envd for the
 * first reader, shared by every reader of that session, and stopped a while
 * after the last one leaves. A new reader first gets the last frame (or
 * `idle`). Frames are capped at one per `minIntervalMs`, keeping the newest.
 * Frames byte-identical to the last one sent are dropped.
 *
 * Take-over: the owner can take control of a view (`takeControl`), send input that the hub turns into
 * CDP commands for the relay's stdin (`input`, rate-limited), and hand it back (`releaseControl`). Control
 * ends by itself after `controlIdleMs` without input, shortly after the last reader leaves, or when the
 * view ends. While a session's browser is under the user's control the agent's browser tools wait
 * (`browser-control.ts`), and after a hand-back with input the agent is told to look at the page again.
 * No address into the sandbox ever leaves the API.
 */
import { randomUUID } from 'node:crypto'
import { EnvdProcessStream } from './remote/envd-stream.ts'
import { BROWSER_LIVE_RELAY_SCRIPT, RELAY_ENV } from './browser-live-relay.ts'
import { toCdpCommand, type BrowserInputEvent } from './browser-input.ts'
import type { EnvdClient } from '@agentry/sandbox/client'

export type LiveFrame = { kind: 'frame'; data: string; url: string; title: string; width?: number; height?: number; ts: number }
/**
 * Why no frames come: `not_started` (no browser open yet, or the sandbox is not running), `no_browser` (the
 * sandbox image has no browser), `browser_off` (the agent's Web browser switch is off), `not_sandbox` (the chat
 * does not run in a sandbox). The last two are decided by the route, never by the relay.
 */
export type IdleReason = 'not_started' | 'no_browser' | 'browser_off' | 'not_sandbox'
export type LiveIdle = { kind: 'idle'; reason: IdleReason }
/** Why control ended: handed back, idle too long, the user left the view, taken by another tab, or the view ended. */
export type ControlEndReason = 'released' | 'idle' | 'left' | 'taken' | 'closed'
export type LiveControl = { kind: 'control'; controlled: true; since: number } | { kind: 'control'; controlled: false; reason: ControlEndReason }
/** Where the agent's pointer is (viewport CSS px, as in the frame) and what it did. Never stored: a new reader gets none. */
export type LivePointer = { kind: 'pointer'; action: 'move' | 'down' | 'up'; x: number; y: number; ts: number }
/** The field the page just focused (viewport CSS px). Never stored. */
export type LiveFocus = { kind: 'focus'; x: number; y: number; width: number; height: number; ts: number }
/**
 * A recording's progress, from the relay (`browser-live-relay.ts`); never sent to live-view readers, only to the
 * recording listener (`BrowserLiveHub.attachRecorder`). `relay_ended` is added by the hub when the relay exits.
 */
export type LiveRecord = {
  kind: 'record'
  state: 'started' | 'stopped' | 'error'
  path?: string
  cursorPath?: string
  reason?: string
  code?: string
  message?: string
  durationMs?: number
  bytes?: number
  frames?: number
  empty?: boolean
}
/** `closed`: the view ended (its environment stopped); the reader should end its stream. */
export type LiveEvent = LiveFrame | LiveIdle | LiveControl | LivePointer | LiveFocus | { kind: 'closed' }

/** The part of `EnvdProcessStream` the hub uses. */
export interface RelayProcess extends NodeJS.ReadableStream {
  readonly exited: Promise<number | null>
  ready(): Promise<number>
  /** Writes a command line to the relay's stdin. */
  write(chunk: string): boolean
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

interface Control {
  id: string
  since: number
  inputs: number
  resized: boolean
  /** The page size before the user's first resize, restored on hand-back. */
  restore: { width: number; height: number } | undefined
  idleTimer: NodeJS.Timeout | undefined
}

interface View extends LiveKey {
  control: Control | undefined
  leaveTimer: NodeJS.Timeout | undefined
  /** Input rate window: its start and the events in it. */
  windowStart: number
  windowEvents: number
  readers: Set<(event: LiveEvent) => void>
  /** Listeners of recording lines (the recorder's hold on this view). */
  recordListeners: Set<(event: LiveRecord) => void>
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
  /** Control ends after this long without input (default 5 minutes). */
  controlIdleMs?: number
  /** Control ends this long after the last reader leaves (default 3 s, so a reconnect keeps it). */
  controlLeaveMs?: number
  /** Most input events a second per session (default 120). */
  maxInputPerSecond?: number
}

export interface ControlGrant {
  controlId: string
  since: number
  idleTimeoutMs: number
}

const MAX_RESTART_MS = 30_000
const NOT_STARTED: LiveIdle = { kind: 'idle', reason: 'not_started' }

/** One frame every `ms`, as the relay's environment; recordings go in `recordingsDir` (absent: refused). */
export function relayEnv(port: number, intervalMs: number, recordingsDir?: string): Record<string, string> {
  return {
    [RELAY_ENV.port]: String(port), [RELAY_ENV.intervalMs]: String(intervalMs), [RELAY_ENV.quality]: '60', [RELAY_ENV.maxWidth]: '1280', [RELAY_ENV.maxHeight]: '960',
    ...(recordingsDir !== undefined && recordingsDir !== '' ? { [RELAY_ENV.recordingsDir]: recordingsDir } : {}),
  }
}

/** The recordings folder of a sandbox workspace (inside the sandbox). */
export function recordingsDirOf(workspace: string): string {
  return `${workspace.replace(/\/+$/, '')}/recordings`
}

/** Starts the relay as `agent` in the sandbox behind `envd`, watching the browser on `port`. */
export function startRelay(envd: EnvdClient, port: number, intervalMs: number, recordingsDir?: string): RelayProcess {
  return new EnvdProcessStream(envd, { cmd: 'node', args: ['-e', BROWSER_LIVE_RELAY_SCRIPT], user: 'agent', env: relayEnv(port, intervalMs, recordingsDir) })
}

/** Parses a relay `record` line. */
function parseRecordLine(m: Record<string, unknown>): LiveRecord | undefined {
  const state = m['state']
  if (state !== 'started' && state !== 'stopped' && state !== 'error') return undefined
  const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const out: LiveRecord = { kind: 'record', state }
  const fields = { path: text(m['path']), cursorPath: text(m['cursorPath']), reason: text(m['reason']), code: text(m['code']), message: text(m['message']), durationMs: count(m['durationMs']), bytes: count(m['bytes']), frames: count(m['frames']) }
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) (out as Record<string, unknown>)[key] = value
  if (m['empty'] === true) out.empty = true
  return out
}

/** Parses one relay line; undefined for anything that is not a frame, idle, pointer, focus or record line. */
export function parseRelayLine(line: string): LiveFrame | LiveIdle | LivePointer | LiveFocus | LiveRecord | undefined {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return undefined
  }
  if (msg === null || typeof msg !== 'object') return undefined
  const m = msg as Record<string, unknown>
  if (m['type'] === 'record') return parseRecordLine(m)
  const coord = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000 ? v : undefined)
  if (m['type'] === 'pointer') {
    const action = m['action']
    const x = coord(m['x'])
    const y = coord(m['y'])
    if ((action !== 'move' && action !== 'down' && action !== 'up') || x === undefined || y === undefined) return undefined
    return { kind: 'pointer', action, x, y, ts: typeof m['ts'] === 'number' && Number.isFinite(m['ts']) ? m['ts'] : Date.now() }
  }
  if (m['type'] === 'focus') {
    const x = coord(m['x'])
    const y = coord(m['y'])
    const width = coord(m['width'])
    const height = coord(m['height'])
    if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
    return { kind: 'focus', x, y, width, height, ts: typeof m['ts'] === 'number' && Number.isFinite(m['ts']) ? m['ts'] : Date.now() }
  }
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
  private readonly controlIdleMs: number
  private readonly controlLeaveMs: number
  private readonly maxInputPerSecond: number
  /** Sessions whose user used the browser and handed it back; the agent must look again. */
  private readonly handedBack = new Set<string>()
  private readonly releaseWaiters = new Map<string, Set<() => void>>()

  constructor(options: BrowserLiveOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 250
    this.stopAfterMs = options.stopAfterMs ?? 10_000
    this.restartMs = options.restartMs ?? 2_000
    this.maxPerOwner = options.maxPerOwner ?? 4
    this.controlIdleMs = options.controlIdleMs ?? 300_000
    this.controlLeaveMs = options.controlLeaveMs ?? 3_000
    this.maxInputPerSecond = options.maxInputPerSecond ?? 120
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
        ...key, readers: new Set(), recordListeners: new Set(), start, relay: undefined, last: undefined, lastSentAt: 0, pending: undefined,
        flushTimer: undefined, stopTimer: undefined, restartTimer: undefined, restartDelay: this.restartMs,
        control: undefined, leaveTimer: undefined, windowStart: 0, windowEvents: 0,
      }
      this.views.set(key.sessionId, view)
    }
    if (view.last !== undefined) onEvent(view.last)
    if (view.control !== undefined) onEvent({ kind: 'control', controlled: true, since: view.control.since })
    view.readers.add(onEvent)
    if (view.stopTimer !== undefined) {
      clearTimeout(view.stopTimer)
      view.stopTimer = undefined
    }
    if (view.leaveTimer !== undefined) {
      clearTimeout(view.leaveTimer)
      view.leaveTimer = undefined
    }
    if (view.relay === undefined && view.restartTimer === undefined) this.run(view)
    const current = view
    return () => {
      current.readers.delete(onEvent)
      if (current.readers.size === 0 && this.views.get(current.sessionId) === current) {
        current.stopTimer = setTimeout(() => { this.dispose(current) }, this.stopAfterMs)
        current.stopTimer.unref?.()
        if (current.control !== undefined) {
          current.leaveTimer = setTimeout(() => {
            current.leaveTimer = undefined
            if (current.readers.size === 0) this.endControl(current, 'left')
          }, this.controlLeaveMs)
          current.leaveTimer.unref?.()
        }
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
    for (const listener of [...view.recordListeners]) listener({ kind: 'record', state: 'stopped', reason: 'relay_ended' })
    this.receive(view, NOT_STARTED)
    if (view.readers.size === 0) return
    view.restartTimer = setTimeout(() => {
      view.restartTimer = undefined
      if (this.views.get(view.sessionId) === view && view.relay === undefined) this.run(view)
    }, view.restartDelay)
    view.restartTimer.unref?.()
    view.restartDelay = Math.min(MAX_RESTART_MS, view.restartDelay * 2)
  }

  private receive(view: View, event: LiveFrame | LiveIdle | LivePointer | LiveFocus | LiveRecord): void {
    if (event.kind === 'record') {
      for (const listener of [...view.recordListeners]) listener(event)
      return
    }
    if (event.kind === 'pointer' || event.kind === 'focus') {
      this.emit(view, event)
      return
    }
    if (event.kind === 'idle') {
      view.pending = undefined
      if (view.last?.kind === 'idle' && view.last.reason === event.reason) return
      view.last = event
      this.emit(view, event)
      return
    }
    view.restartDelay = this.restartMs
    const shown = view.pending ?? view.last
    if (shown?.kind === 'frame' && shown.data === event.data && shown.url === event.url && shown.title === event.title) return
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
    if (view.control !== undefined) this.endControl(view, 'closed', notify)
    for (const timer of [view.flushTimer, view.stopTimer, view.restartTimer, view.leaveTimer]) if (timer !== undefined) clearTimeout(timer)
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
    view.recordListeners.clear()
  }

  /**
   * A recording's hold on `key`'s view: a reader (so the relay keeps running with no viewer) plus a listener of
   * the relay's `record` lines. Throws like `attach`.
   * @returns the release function.
   */
  attachRecorder(key: LiveKey, start: () => RelayProcess, onEvent: (event: LiveEvent) => void, onRecord: (event: LiveRecord) => void): () => void {
    const detach = this.attach(key, start, onEvent)
    const view = this.views.get(key.sessionId)
    view?.recordListeners.add(onRecord)
    return () => {
      view?.recordListeners.delete(onRecord)
      detach()
    }
  }

  /** Sends a `record` command to `sessionId`'s relay. @returns false when no relay runs. */
  recordCommand(sessionId: string, command: Record<string, unknown>): boolean {
    const relay = this.views.get(sessionId)?.relay
    if (relay === undefined) return false
    relay.write(`${JSON.stringify({ ...command, type: 'record' })}\n`)
    return true
  }

  /**
   * Gives the owner control of `sessionId`'s browser. A reader must be watching it (the user sees what they
   * click). Control held by another tab is taken over only with `force`.
   * @throws BrowserLiveError 404 (no such view for this owner), 409 `browser_not_live`, 409 `browser_control_held`.
   */
  takeControl(owner: string, sessionId: string, force = false): ControlGrant {
    const view = this.views.get(sessionId)
    if (view !== undefined && view.owner !== owner) throw new BrowserLiveError('session not found', 404, 'not_found')
    if (view === undefined || view.readers.size === 0) {
      throw new BrowserLiveError('open the live browser view before taking control', 409, 'browser_not_live')
    }
    if (view.control !== undefined) {
      if (!force) throw new BrowserLiveError('you already control this browser in another tab', 409, 'browser_control_held')
      this.endControl(view, 'taken')
    }
    const control: Control = { id: `bctl_${randomUUID().replaceAll('-', '')}`, since: Date.now(), inputs: 0, resized: false, restore: undefined, idleTimer: undefined }
    view.control = control
    this.armIdle(view, control)
    this.emit(view, { kind: 'control', controlled: true, since: control.since })
    return { controlId: control.id, since: control.since, idleTimeoutMs: this.controlIdleMs }
  }

  /**
   * Hands control back. With a `controlId`, only that grant is released (an older tab's release does not
   * end a newer one). Releasing when nobody has control is fine.
   * @returns whether control was released.
   */
  releaseControl(owner: string, sessionId: string, controlId?: string): boolean {
    const view = this.views.get(sessionId)
    if (view === undefined || view.owner !== owner || view.control === undefined) return false
    if (controlId !== undefined && view.control.id !== controlId) return false
    this.endControl(view, 'released')
    return true
  }

  /**
   * Sends the user's input to the page through the relay.
   * @throws BrowserLiveError 409 `not_in_control` (no control, or another grant), 429 `input_rate_limited`.
   */
  input(owner: string, sessionId: string, controlId: string, events: readonly BrowserInputEvent[]): void {
    const view = this.views.get(sessionId)
    const control = view?.owner === owner ? view.control : undefined
    if (view === undefined || control === undefined || control.id !== controlId) {
      throw new BrowserLiveError('you do not have control of this browser; take control first', 409, 'not_in_control')
    }
    const now = Date.now()
    if (now - view.windowStart >= 1000) {
      view.windowStart = now
      view.windowEvents = 0
    }
    if (view.windowEvents + events.length > this.maxInputPerSecond) {
      throw new BrowserLiveError('too much input; slow down', 429, 'input_rate_limited')
    }
    view.windowEvents += events.length
    control.inputs += events.length
    if (events.some(e => e.type === 'resize') && !control.resized) {
      control.resized = true
      const shown = view.last?.kind === 'frame' ? view.last : undefined
      if (shown?.width !== undefined && shown.height !== undefined) control.restore = { width: Math.round(shown.width), height: Math.round(shown.height) }
    }
    this.armIdle(view, control)
    view.relay?.write(`${JSON.stringify({ type: 'input', commands: events.map(toCdpCommand) })}\n`)
  }

  /** Whether the user has control of `sessionId`'s browser. */
  controlled(sessionId: string): boolean {
    return this.views.get(sessionId)?.control !== undefined
  }

  /** Resolves when the user no longer has control of `sessionId`'s browser (at once if they do not), or `signal` aborts. */
  waitForRelease(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (!this.controlled(sessionId) || signal?.aborted === true) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.releaseWaiters.get(sessionId) ?? new Set()
      this.releaseWaiters.set(sessionId, waiters)
      const done = () => {
        waiters.delete(done)
        if (waiters.size === 0 && this.releaseWaiters.get(sessionId) === waiters) this.releaseWaiters.delete(sessionId)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Whether the user used `sessionId`'s browser and handed it back since the agent last looked at it. */
  handedBackSince(sessionId: string): boolean {
    return this.handedBack.has(sessionId)
  }

  /** The agent looked at the page again. */
  clearHandedBack(sessionId: string): void {
    this.handedBack.delete(sessionId)
  }

  private armIdle(view: View, control: Control): void {
    if (control.idleTimer !== undefined) clearTimeout(control.idleTimer)
    control.idleTimer = setTimeout(() => {
      if (view.control === control) this.endControl(view, 'idle')
    }, this.controlIdleMs)
    control.idleTimer.unref?.()
  }

  private endControl(view: View, reason: ControlEndReason, notify = true): void {
    const control = view.control
    if (control === undefined) return
    view.control = undefined
    if (control.idleTimer !== undefined) clearTimeout(control.idleTimer)
    if (view.leaveTimer !== undefined) {
      clearTimeout(view.leaveTimer)
      view.leaveTimer = undefined
    }
    if (control.inputs > 0) this.handedBack.add(view.sessionId)
    if (control.resized) view.relay?.write(`${JSON.stringify({ type: 'control', on: false, resized: true, ...(control.restore ? { restore: control.restore } : {}) })}\n`)
    if (notify) this.emit(view, { kind: 'control', controlled: false, reason })
    const waiters = this.releaseWaiters.get(view.sessionId)
    if (waiters !== undefined) for (const done of [...waiters]) done()
  }

  /** Ends the views of an environment that was stopped, reset or deleted. */
  closeEnvironment(environmentId: string): void {
    for (const view of [...this.views.values()]) if (view.environmentId === environmentId) this.dispose(view, true)
  }

  stop(): void {
    for (const view of [...this.views.values()]) this.dispose(view, true)
  }
}
