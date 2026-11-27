/**
 * Browser recordings of sandbox chats (`browser_recording_start` / `browser_recording_stop`).
 *
 * A recording runs in the sandbox, inside the live-view relay (`browser-live-relay.ts`): the recorder holds the
 * session's relay open through the hub (`BrowserLiveHub.attachRecorder`) so it keeps running with no viewer,
 * sends it `record` commands, and waits for its `record` answers. Files go to the workspace's `recordings/`
 * folder: `<name>.webm` plus `<name>.cursor.jsonl` (the agent's pointer, drawn over the video by the web app).
 *
 * Auto-stop: the relay stops by itself at the time and size limits; the gateway stops a recording when the
 * turn ends (`turnEnded`). A recording that stopped without `browser_recording_stop` is kept for the next
 * recording tool result (`takeAutoStopped`) and logged.
 */
import type { BrowserLiveHub, LiveEvent, LiveKey, LiveRecord, RelayProcess } from './browser-live.ts'
import { recordingsDirOf } from './browser-live.ts'

/** A finished recording, as the tools report it (paths relative to the workspace). */
export interface RecordingResult {
  path: string
  cursor_path: string
  duration_seconds: number
  size_bytes: number
  /** Why it stopped: `stopped` (the tool), `turn_end`, `time_limit`, `size_limit`, `closed`, `relay_ended`, `ffmpeg_exited`. */
  reason: string
}

export class BrowserRecordingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Where and how to record one session's browser. */
export interface RecordingTarget extends LiveKey {
  /** The sandbox workspace (inside the sandbox). */
  workspace: string
  /** Starts the session's relay (with the workspace's recordings folder). */
  start: () => RelayProcess
}

export interface BrowserRecorderOptions {
  /** Longest recording (default 15 minutes). */
  maxMs?: number
  /** Largest recording file (default 200 MB). */
  maxBytes?: number
  /** How long to wait for the browser's first frame (default 8 s). */
  firstFrameMs?: number
  /** How long to wait for the relay to answer a start (default 10 s) or a stop (default 30 s). */
  startReplyMs?: number
  stopReplyMs?: number
  /** Log line for a recording that stopped by itself. */
  log?: (message: string) => void
  /** The time, for default names (tests pin it). */
  now?: () => Date
}

interface Active {
  target: RecordingTarget
  path: string
  cursorPath: string
  release: () => void
  stopped: Promise<RecordingResult>
  stopping: boolean
  reason: string | undefined
}

/** `name` made safe for a file name, or the default `recording-<yyyymmdd-hhmmss>` (UTC). */
export function recordingName(name: string | undefined, now: Date): string {
  const cleaned = (name ?? '')
    .trim()
    .replace(/\.webm$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 80)
  if (cleaned !== '') return cleaned
  const p = (n: number) => String(n).padStart(2, '0')
  return `recording-${String(now.getUTCFullYear())}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
}

/** `path` relative to `workspace` when inside it. */
function relativeTo(workspace: string, path: string): string {
  const base = workspace.replace(/\/+$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

export class BrowserRecorder {
  private readonly active = new Map<string, Active>()
  private readonly autoStopped = new Map<string, RecordingResult>()
  private readonly maxMs: number
  private readonly maxBytes: number
  private readonly firstFrameMs: number
  private readonly startReplyMs: number
  private readonly stopReplyMs: number
  private readonly log: (message: string) => void
  private readonly now: () => Date

  constructor(private readonly hub: BrowserLiveHub, options: BrowserRecorderOptions = {}) {
    this.maxMs = options.maxMs ?? 15 * 60_000
    this.maxBytes = options.maxBytes ?? 200 * 1024 * 1024
    this.firstFrameMs = options.firstFrameMs ?? 8_000
    this.startReplyMs = options.startReplyMs ?? 10_000
    this.stopReplyMs = options.stopReplyMs ?? 30_000
    this.log = options.log ?? (() => {})
    this.now = options.now ?? (() => new Date())
  }

  /** Whether `sessionId` is recording. */
  recording(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /** The limits, for the tool's answer. */
  get limits(): { max_minutes: number; max_megabytes: number } {
    return { max_minutes: Math.round(this.maxMs / 60_000), max_megabytes: Math.round(this.maxBytes / (1024 * 1024)) }
  }

  /**
   * Starts recording the page the session's live view follows.
   * @returns the workspace-relative paths of the video and its cursor file.
   * @throws BrowserRecordingError `already_recording`, `browser_not_started`, `recording_unavailable`, `recording_failed`, or the hub's view limit (`too_many_live_views`).
   */
  async start(target: RecordingTarget, name?: string): Promise<{ path: string; cursor_path: string }> {
    const sessionId = target.sessionId
    if (this.active.has(sessionId)) throw new BrowserRecordingError('already_recording', 'A recording is already running in this chat; stop it with browser_recording_stop first.')
    const stem = recordingName(name, this.now())
    const dir = recordingsDirOf(target.workspace)

    let onEvent: (event: LiveEvent) => void = () => {}
    let onRecord: (event: LiveRecord) => void = () => {}
    let release: () => void
    try {
      release = this.hub.attachRecorder(target, target.start, (e) => { onEvent(e) }, (e) => { onRecord(e) })
    } catch (error) {
      const code = (error as { code?: unknown }).code
      throw new BrowserRecordingError(typeof code === 'string' ? code : 'recording_failed', error instanceof Error ? error.message : String(error))
    }
    // A placeholder entry so a second start while this one is setting up is refused.
    const placeholder = { target, release } as unknown as Active
    this.active.set(sessionId, placeholder)
    const fail = (error: BrowserRecordingError): BrowserRecordingError => {
      if (this.active.get(sessionId) === placeholder) this.active.delete(sessionId)
      release()
      return error
    }

    // The browser must be showing a page (a frame), not idle.
    const shown = await new Promise<'frame' | 'idle' | 'timeout' | 'closed'>((resolve) => {
      const timer = setTimeout(() => { resolve('timeout') }, this.firstFrameMs)
      timer.unref?.()
      onEvent = (e) => {
        if (e.kind === 'frame' || e.kind === 'idle' || e.kind === 'closed') {
          clearTimeout(timer)
          onEvent = () => {}
          resolve(e.kind)
        }
      }
    })
    if (shown !== 'frame') {
      throw fail(new BrowserRecordingError('browser_not_started', 'The browser has not started (no page is open). Open a page with the browser tools first, then start recording.'))
    }

    let resolveStopped!: (result: RecordingResult) => void
    const stopped = new Promise<RecordingResult>((resolve) => { resolveStopped = resolve })
    const answer = await new Promise<LiveRecord | undefined>((resolve) => {
      const timer = setTimeout(() => { resolve(undefined) }, this.startReplyMs)
      timer.unref?.()
      onRecord = (e) => {
        if (e.state === 'started' || e.state === 'error' || e.state === 'stopped') {
          clearTimeout(timer)
          resolve(e)
        }
      }
      const sent = this.hub.recordCommand(sessionId, {
        on: true,
        path: `${dir}/${stem}.webm`,
        cursorPath: `${dir}/${stem}.cursor.jsonl`,
        maxMs: this.maxMs,
        maxBytes: this.maxBytes,
      })
      if (!sent) {
        clearTimeout(timer)
        resolve(undefined)
      }
    })
    if (answer?.state !== 'started' || answer.path === undefined || answer.cursorPath === undefined) {
      if (answer?.state === 'error' && answer.code === 'recording_unavailable') {
        throw fail(new BrowserRecordingError('recording_unavailable', 'This sandbox cannot record the browser (no ffmpeg in its image).'))
      }
      throw fail(new BrowserRecordingError('recording_failed', `The recording did not start${answer?.message !== undefined ? `: ${answer.message}` : '.'}`))
    }
    const entry: Active = { target, path: answer.path, cursorPath: answer.cursorPath, release, stopped, stopping: false, reason: undefined }
    this.active.set(sessionId, entry)
    const finish = (e: LiveRecord): void => {
      if (this.active.get(sessionId) !== entry) return
      this.active.delete(sessionId)
      release()
      const result: RecordingResult = {
        path: relativeTo(target.workspace, e.path ?? entry.path),
        cursor_path: relativeTo(target.workspace, e.cursorPath ?? entry.cursorPath),
        duration_seconds: Math.round((e.durationMs ?? 0) / 100) / 10,
        size_bytes: e.bytes ?? 0,
        reason: entry.reason ?? e.reason ?? 'stopped',
      }
      if (!entry.stopping) {
        this.autoStopped.set(sessionId, result)
        this.log(`agents-api: browser recording ${result.path} for session ${sessionId} stopped by itself (${result.reason}, ${String(result.duration_seconds)} s, ${String(result.size_bytes)} bytes)`)
      }
      resolveStopped(result)
    }
    onRecord = (e) => { if (e.state === 'stopped') finish(e) }
    onEvent = (e) => { if (e.kind === 'closed') finish({ kind: 'record', state: 'stopped', reason: 'closed' }) }
    return { path: relativeTo(target.workspace, entry.path), cursor_path: relativeTo(target.workspace, entry.cursorPath) }
  }

  /**
   * Stops the session's recording and waits for the file.
   * @param reason - why (`stopped` from the tool, `turn_end` from the gateway).
   * @throws BrowserRecordingError `not_recording`.
   */
  async stop(sessionId: string, reason = 'stopped'): Promise<RecordingResult> {
    const entry = this.active.get(sessionId)
    if (entry?.stopped === undefined) throw new BrowserRecordingError('not_recording', 'No recording is running in this chat.')
    if (!entry.stopping) {
      entry.stopping = true
      entry.reason = reason
      // Without a relay the recording ended with it; the hub's `relay_ended` finishes it.
      this.hub.recordCommand(sessionId, { on: false })
    }
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<RecordingResult>((_, reject) => {
      timer = setTimeout(() => { reject(new BrowserRecordingError('recording_failed', 'The recording did not finish in time.')) }, this.stopReplyMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([entry.stopped, timeout])
    } catch (error) {
      if (this.active.get(sessionId) === entry) {
        this.active.delete(sessionId)
        entry.release()
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The turn ended: stop a running recording; its result is kept for the next recording tool call.
   * @returns a promise that settles when the file is finished, or undefined when nothing was recording.
   */
  turnEnded(sessionId: string): Promise<void> | undefined {
    const entry = this.active.get(sessionId)
    if (entry?.stopped === undefined || entry.stopping) return undefined
    return this.stop(sessionId, 'turn_end').then(
      (result) => {
        this.autoStopped.set(sessionId, result)
        this.log(`agents-api: browser recording ${result.path} for session ${sessionId} stopped at the end of the turn (${String(result.duration_seconds)} s, ${String(result.size_bytes)} bytes)`)
      },
      (error: unknown) => { this.log(`agents-api: browser recording for session ${sessionId} did not finish at the end of the turn: ${error instanceof Error ? error.message : String(error)}`) },
    )
  }

  /** The recording that stopped by itself since the last recording tool call, if any (forgotten once read). */
  takeAutoStopped(sessionId: string): RecordingResult | undefined {
    const result = this.autoStopped.get(sessionId)
    this.autoStopped.delete(sessionId)
    return result
  }

  /** The session is gone: stop its recording (the file is kept) and forget it. */
  forget(sessionId: string): void {
    this.autoStopped.delete(sessionId)
    if (this.active.get(sessionId)?.stopped !== undefined) void this.stop(sessionId, 'closed').catch(() => {})
  }
}
