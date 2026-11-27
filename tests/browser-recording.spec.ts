/** Browser recordings: the relay's record command and recorder, the hub's record lines, the API recorder and the tools. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { RELAY_RECORD_SOURCE, recordingFfmpegArgs } from '../src/sandbox/browser-live-relay.ts'
import { BrowserLiveHub, parseRelayLine, type LiveKey, type RelayProcess } from '../src/sandbox/browser-live.ts'
import { BrowserRecorder, recordingName } from '../src/sandbox/browser-recording.ts'
import { BROWSER_RECORDING_START, BROWSER_RECORDING_STOP, mountBrowserRecordingTools } from '../src/mount-browser-recording.ts'
import type { Context } from '@deepseek-ai/cordis'

type Rec = { start: (c: unknown) => void; frame: (d: string, w: number, h: number) => void; cursor: (l: unknown) => void; stop: (r: string) => Promise<void>; active: () => boolean }
const relayRecord = new Function('Buffer', `${RELAY_RECORD_SOURCE}; return { recordCommand, createRecorder }`)(Buffer) as {
  recordCommand: (line: string, dir: string) => Record<string, unknown> | undefined
  createRecorder: (d: Record<string, unknown>) => Rec
}

describe('recordCommand (relay)', () => {
  const dir = '/workspace/recordings'
  const cmd = (o: Record<string, unknown>) => relayRecord.recordCommand(JSON.stringify({ type: 'record', ...o }), dir)

  it('accepts a .webm directly in the recordings folder with its cursor file beside it', () => {
    expect(cmd({ on: true, path: `${dir}/demo.webm`, cursorPath: `${dir}/demo.cursor.jsonl`, maxMs: 1000, maxBytes: 5000 }))
      .toEqual({ on: true, dir, stem: 'demo', maxMs: 1000, maxBytes: 5000 })
    expect(cmd({ on: false })).toEqual({ on: false })
  })

  it('refuses paths outside recordings/, nested, traversal, other extensions, or a mismatched cursor file', () => {
    for (const path of ['/workspace/demo.webm', `${dir}/../demo.webm`, `${dir}/sub/demo.webm`, `${dir}/demo.mp4`, `${dir}/.hidden.webm`, `${dir}/a..b.webm`, '/etc/passwd', `${dir}/`]) {
      expect(cmd({ on: true, path, cursorPath: path.replace(/\.webm$/, '.cursor.jsonl') })).toEqual({ invalid: true })
    }
    expect(cmd({ on: true, path: `${dir}/demo.webm`, cursorPath: '/tmp/x.cursor.jsonl' })).toEqual({ invalid: true })
    expect(relayRecord.recordCommand(JSON.stringify({ type: 'record', on: true, path: '/x/demo.webm', cursorPath: '/x/demo.cursor.jsonl' }), '')).toEqual({ invalid: true })
  })

  it('falls back to the default limits and ignores other lines', () => {
    expect(cmd({ on: true, path: `${dir}/a.webm`, cursorPath: `${dir}/a.cursor.jsonl`, maxMs: -1, maxBytes: 'x' })).toMatchObject({ maxMs: 900000, maxBytes: 104857600 })
    expect(relayRecord.recordCommand('{"type":"input","commands":[]}', dir)).toBeUndefined()
    expect(relayRecord.recordCommand('nope', dir)).toBeUndefined()
  })
})

function fakeRelayDeps() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const lines: Record<string, unknown>[] = []
  const procs: { args: string[]; written: Buffer[]; ended: boolean; exit: (code: number) => void }[] = []
  let now = 1_000_000
  let tick: (() => void) | undefined
  const deps = {
    fps: 10, maxWidth: 1280, maxHeight: 960,
    now: () => now,
    out: (o: Record<string, unknown>) => { lines.push(o) },
    ffmpeg: () => '/opt/ffmpeg' as string | undefined,
    args: (w: number, h: number) => recordingFfmpegArgs(w, h),
    every: (fn: () => void) => { tick = fn; return 1 },
    cancel: () => { tick = undefined },
    fs: {
      statSync: (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { size: files.get(p)!.length } },
      mkdirSync: (p: string) => { dirs.add(p) },
      writeFileSync: (p: string, d: string) => { files.set(p, d) },
      appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) ?? '') + d) },
      unlinkSync: (p: string) => { files.delete(p) },
    },
    spawn: (_bin: string, args: string[]) => {
      const proc = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { write: (b: Buffer) => void; end: () => void }; stderr: null; kill: () => void }
      const record = { args, written: [] as Buffer[], ended: false, exit: (code: number) => { proc.emit('exit', code) } }
      const out = args[args.length - 1]!
      proc.stdin = Object.assign(new EventEmitter(), {
        write: (b: Buffer) => { record.written.push(b); files.set(out, (files.get(out) ?? '') + 'x'.repeat(b.length)) },
        end: () => { record.ended = true; setTimeout(() => { record.exit(0) }, 0) },
      })
      proc.stderr = null
      proc.kill = () => {}
      procs.push(record)
      return proc
    },
  }
  return {
    deps, files, dirs, lines, procs,
    advance: (ms: number) => { now += ms; tick?.() },
    get now() { return now },
  }
}

const START = (stem = 'demo', extra: Record<string, unknown> = {}) => ({ on: true, dir: '/w/recordings', stem, maxMs: 900000, maxBytes: 104857600, ...extra })
const JPEG = Buffer.from('frame').toString('base64')

describe('createRecorder (relay)', () => {
  it('pipes frames to ffmpeg at a fixed rate, repeating the last one, and finishes the file on stop', async () => {
    const f = fakeRelayDeps()
    const rec = relayRecord.createRecorder(f.deps)
    rec.start(START())
    expect(f.lines[0]).toEqual({ type: 'record', state: 'started', path: '/w/recordings/demo.webm', cursorPath: '/w/recordings/demo.cursor.jsonl' })
    expect(f.dirs.has('/w/recordings')).toBe(true)
    rec.frame(JPEG, 800, 600)
    expect(f.procs).toHaveLength(1)
    expect(f.procs[0]!.args).toEqual([...recordingFfmpegArgs(800, 600), '/w/recordings/demo.webm'])
    expect(f.procs[0]!.written).toHaveLength(1)
    f.advance(1000) // a second with no new frame: the last one is repeated
    expect(f.procs[0]!.written).toHaveLength(11)
    await rec.stop('stopped')
    expect(f.procs[0]!.ended).toBe(true)
    expect(f.lines.at(-1)).toMatchObject({ type: 'record', state: 'stopped', reason: 'stopped', path: '/w/recordings/demo.webm', durationMs: 1100, frames: 11, empty: false })
    expect(rec.active()).toBe(false)
  })

  it('fits the video into the maximum size with even numbers', () => {
    const f = fakeRelayDeps()
    const rec = relayRecord.createRecorder(f.deps)
    rec.start(START())
    rec.frame(JPEG, 2561, 1441)
    expect(f.procs[0]!.args).toContain('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:gray,format=yuv420p')
  })

  it('writes pointer and focus lines with their time from the first frame, and viewport changes', async () => {
    const f = fakeRelayDeps()
    const rec = relayRecord.createRecorder(f.deps)
    rec.start(START())
    rec.cursor({ type: 'pointer', action: 'move', x: 1, y: 1, ts: f.now }) // before any frame: no video time yet
    rec.frame(JPEG, 800, 600)
    const t0 = f.now
    rec.cursor({ type: 'pointer', action: 'down', x: 10, y: 20, ts: t0 + 250 })
    rec.cursor({ type: 'focus', x: 5, y: 6, width: 100, height: 20, ts: t0 + 300 })
    rec.cursor({ type: 'frame' })
    f.advance(400)
    rec.frame(JPEG, 400, 300)
    await rec.stop('stopped')
    const cursor = f.files.get('/w/recordings/demo.cursor.jsonl')!.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(cursor).toEqual([
      { type: 'meta', version: 1, fps: 10, started_at: t0 },
      { t: 0, type: 'viewport', width: 800, height: 600, video_width: 800, video_height: 600 },
      { t: 250, type: 'pointer', action: 'down', x: 10, y: 20 },
      { t: 300, type: 'focus', x: 5, y: 6, width: 100, height: 20 },
      { t: 400, type: 'viewport', width: 400, height: 300 },
    ])
  })

  it('stops by itself at the time limit and at the size limit', async () => {
    const timed = fakeRelayDeps()
    const a = relayRecord.createRecorder(timed.deps)
    a.start(START('a', { maxMs: 2000 }))
    a.frame(JPEG, 800, 600)
    timed.advance(2000)
    await vi.waitFor(() => { expect(timed.lines.at(-1)).toMatchObject({ state: 'stopped', reason: 'time_limit' }) })
    expect(a.active()).toBe(false)

    const big = fakeRelayDeps()
    const b = relayRecord.createRecorder(big.deps)
    b.start(START('b', { maxBytes: 40 }))
    b.frame(JPEG, 800, 600) // 5 bytes a frame in the fake
    for (let i = 0; i < 10; i++) big.advance(100)
    await vi.waitFor(() => { expect(big.lines.at(-1)).toMatchObject({ state: 'stopped', reason: 'size_limit' }) })
  })

  it('stops when ffmpeg ends on its own', async () => {
    const f = fakeRelayDeps()
    const rec = relayRecord.createRecorder(f.deps)
    rec.start(START())
    rec.frame(JPEG, 800, 600)
    f.procs[0]!.exit(1)
    await vi.waitFor(() => { expect(f.lines.at(-1)).toMatchObject({ state: 'stopped', reason: 'ffmpeg_exited' }) })
  })

  it('picks -2, -3 when the name is taken', () => {
    const f = fakeRelayDeps()
    f.files.set('/w/recordings/demo.webm', '')
    f.files.set('/w/recordings/demo-2.cursor.jsonl', '')
    const rec = relayRecord.createRecorder(f.deps)
    rec.start(START())
    expect(f.lines[0]).toMatchObject({ path: '/w/recordings/demo-3.webm', cursorPath: '/w/recordings/demo-3.cursor.jsonl' })
  })

  it('refuses a second start, a stop when idle, and a sandbox without ffmpeg', async () => {
    const f = fakeRelayDeps()
    const rec = relayRecord.createRecorder(f.deps)
    await rec.stop('stopped')
    expect(f.lines.at(-1)).toMatchObject({ state: 'error', code: 'not_recording' })
    rec.start(START())
    rec.start(START('other'))
    expect(f.lines.at(-1)).toMatchObject({ state: 'error', code: 'already_recording' })
    const none = fakeRelayDeps()
    none.deps.ffmpeg = () => undefined
    relayRecord.createRecorder(none.deps).start(START())
    expect(none.lines).toEqual([{ type: 'record', state: 'error', code: 'recording_unavailable', message: 'this sandbox has no ffmpeg for recording' }])
  })

  it('reports an empty recording (no frame ever came) and removes its cursor file', async () => {
    const f = fakeRelayDeps()
    const rec = relayRecord.createRecorder(f.deps)
    rec.start(START())
    await rec.stop('stopped')
    expect(f.lines.at(-1)).toMatchObject({ state: 'stopped', empty: true, bytes: 0, frames: 0 })
    expect(f.files.has('/w/recordings/demo.cursor.jsonl')).toBe(false)
  })
})

describe('record lines in the hub', () => {
  it('parses record lines', () => {
    expect(parseRelayLine('{"type":"record","state":"stopped","path":"/w/recordings/a.webm","cursorPath":"/w/recordings/a.cursor.jsonl","durationMs":1500,"bytes":42,"reason":"time_limit","frames":15}'))
      .toEqual({ kind: 'record', state: 'stopped', path: '/w/recordings/a.webm', cursorPath: '/w/recordings/a.cursor.jsonl', durationMs: 1500, bytes: 42, reason: 'time_limit', frames: 15 })
    expect(parseRelayLine('{"type":"record","state":"weird"}')).toBeUndefined()
  })
})

/** A relay that answers record commands the way the program does. */
class FakeRelay extends PassThrough implements RelayProcess {
  readonly commands: Record<string, unknown>[] = []
  exitedResolve!: (code: number | null) => void
  readonly exited = new Promise<number | null>((resolve) => { this.exitedResolve = resolve })
  constructor(private readonly behave: (cmd: Record<string, unknown>, relay: FakeRelay) => void) {
    super()
  }

  ready(): Promise<number> { return Promise.resolve(1) }
  override write(chunk: string): boolean {
    const cmd = JSON.parse(chunk) as Record<string, unknown>
    this.commands.push(cmd)
    this.behave(cmd, this)
    return true
  }

  line(o: Record<string, unknown>): void { this.push(`${JSON.stringify(o)}\n`) }
  override end(): this { return this }
  kill(): Promise<void> { this.exitedResolve(0); return Promise.resolve() }
}

const KEY: LiveKey = { owner: 'o', sessionId: 's', environmentId: 'env_1' }
const FRAME = { type: 'frame', data: 'AAAA', url: 'https://x', title: 't', width: 800, height: 600, ts: 1 }

function recorderSetup(opts: { frame?: boolean; behave?: (cmd: Record<string, unknown>, relay: FakeRelay) => void } = {}) {
  const hub = new BrowserLiveHub({ minIntervalMs: 0, stopAfterMs: 10 })
  const log = vi.fn()
  const recorder = new BrowserRecorder(hub, { firstFrameMs: 50, startReplyMs: 50, stopReplyMs: 200, log, now: () => new Date(Date.UTC(2026, 10, 27, 9, 8, 7)) })
  const relays: FakeRelay[] = []
  const behave = opts.behave ?? ((cmd, relay) => {
    if (cmd['on'] === true) relay.line({ type: 'record', state: 'started', path: cmd['path'], cursorPath: cmd['cursorPath'] })
    else relay.line({ type: 'record', state: 'stopped', reason: 'stopped', path: '/workspace/recordings/recording-20261127-090807.webm', cursorPath: '/workspace/recordings/recording-20261127-090807.cursor.jsonl', durationMs: 4200, bytes: 1234 })
  })
  const start = vi.fn(() => {
    const relay = new FakeRelay(behave)
    relays.push(relay)
    setTimeout(() => { relay.line(opts.frame === false ? { type: 'idle', reason: 'not_started' } : FRAME) }, 1)
    return relay
  })
  const target = { ...KEY, workspace: '/workspace', start }
  return { hub, recorder, relays, start, target, log }
}

describe('BrowserRecorder', () => {
  it('starts and stops, holding the relay meanwhile', async () => {
    const { recorder, relays, target, hub } = recorderSetup()
    const started = await recorder.start(target)
    expect(started).toEqual({ path: 'recordings/recording-20261127-090807.webm', cursor_path: 'recordings/recording-20261127-090807.cursor.jsonl' })
    expect(relays[0]!.commands[0]).toEqual({ type: 'record', on: true, path: '/workspace/recordings/recording-20261127-090807.webm', cursorPath: '/workspace/recordings/recording-20261127-090807.cursor.jsonl', maxMs: 900000, maxBytes: 104857600 })
    expect(recorder.recording('s')).toBe(true)
    const result = await recorder.stop('s')
    expect(result).toEqual({ path: 'recordings/recording-20261127-090807.webm', cursor_path: 'recordings/recording-20261127-090807.cursor.jsonl', duration_seconds: 4.2, size_bytes: 1234, reason: 'stopped' })
    expect(recorder.recording('s')).toBe(false)
    expect(recorder.takeAutoStopped('s')).toBeUndefined()
    hub.stop()
  })

  it('refuses a second start, a stop when idle, and a browser with no page', async () => {
    const { recorder, target, hub } = recorderSetup()
    await expect(recorder.stop('s')).rejects.toMatchObject({ code: 'not_recording' })
    await recorder.start(target, 'demo')
    await expect(recorder.start(target)).rejects.toMatchObject({ code: 'already_recording' })
    hub.stop()
    const idle = recorderSetup({ frame: false })
    await expect(idle.recorder.start(idle.target)).rejects.toMatchObject({ code: 'browser_not_started' })
    expect(idle.recorder.recording('s')).toBe(false)
    idle.hub.stop()
  })

  it('says when the sandbox cannot record', async () => {
    const { recorder, target, hub } = recorderSetup({ behave: (_cmd, relay) => { relay.line({ type: 'record', state: 'error', code: 'recording_unavailable', message: 'no ffmpeg' }) } })
    await expect(recorder.start(target)).rejects.toMatchObject({ code: 'recording_unavailable' })
    expect(recorder.recording('s')).toBe(false)
    hub.stop()
  })

  it('stops at the end of the turn and reports it with the next call', async () => {
    const { recorder, target, log, hub } = recorderSetup()
    await recorder.start(target, 'demo')
    const done = recorder.turnEnded('s')
    expect(done).toBeDefined()
    await done
    expect(recorder.recording('s')).toBe(false)
    expect(recorder.takeAutoStopped('s')).toMatchObject({ reason: 'turn_end', size_bytes: 1234 })
    expect(recorder.takeAutoStopped('s')).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stopped at the end of the turn'))
    expect(recorder.turnEnded('s')).toBeUndefined()
    hub.stop()
  })

  it('keeps a recording the relay stopped by itself (limits) for the next call, and logs it', async () => {
    const { recorder, relays, target, log, hub } = recorderSetup()
    await recorder.start(target, 'demo')
    relays[0]!.line({ type: 'record', state: 'stopped', reason: 'size_limit', path: '/workspace/recordings/demo.webm', cursorPath: '/workspace/recordings/demo.cursor.jsonl', durationMs: 60000, bytes: 209715300 })
    await vi.waitFor(() => { expect(recorder.recording('s')).toBe(false) })
    expect(recorder.takeAutoStopped('s')).toEqual({ path: 'recordings/demo.webm', cursor_path: 'recordings/demo.cursor.jsonl', duration_seconds: 60, size_bytes: 209715300, reason: 'size_limit' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stopped by itself (size_limit'))
    hub.stop()
  })

  it('names recordings safely', () => {
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    expect(recordingName(undefined, now)).toBe('recording-20260102-030405')
    expect(recordingName('  Sign up form.webm ', now)).toBe('Sign-up-form')
    expect(recordingName('../../etc/passwd', now)).toBe('etc-passwd')
    expect(recordingName('...', now)).toBe('recording-20260102-030405')
  })
})

describe('recording tools', () => {
  function tools() {
    const registered = new Map<string, { execute: (args: unknown) => Promise<string> }>()
    const agentCtx = { tools: { register: (def: { name: string; execute: (args: unknown) => Promise<string> }) => { registered.set(def.name, def) } } } as unknown as Context
    const setup = recorderSetup()
    mountBrowserRecordingTools(agentCtx, setup.recorder, setup.target)
    return { ...setup, start: registered.get(BROWSER_RECORDING_START)!, stop: registered.get(BROWSER_RECORDING_STOP)! }
  }

  it('answer with paths and limits, and refusals as error codes', async () => {
    const t = tools()
    expect(JSON.parse(await t.stop.execute({}))).toMatchObject({ error: 'not_recording' })
    expect(JSON.parse(await t.start.execute({ name: 'demo' }))).toEqual({ recording: true, path: 'recordings/demo.webm', cursor_path: 'recordings/demo.cursor.jsonl', max_minutes: 15, max_megabytes: 100 })
    expect(JSON.parse(await t.start.execute({}))).toMatchObject({ error: 'already_recording' })
    expect(JSON.parse(await t.stop.execute({}))).toMatchObject({ path: expect.stringMatching(/^recordings\//), duration_seconds: 4.2, size_bytes: 1234 })
    t.hub.stop()
  })

  it('reports a recording that stopped at the turn end in the next call', async () => {
    const t = tools()
    await t.start.execute({ name: 'demo' })
    await t.recorder.turnEnded('s')
    expect(JSON.parse(await t.stop.execute({}))).toMatchObject({ reason: 'turn_end', note: expect.stringContaining('already stopped') })
    t.hub.stop()
  })
})
