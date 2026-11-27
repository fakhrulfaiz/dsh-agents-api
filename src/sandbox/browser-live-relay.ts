/**
 * The live-view relay: a small Node program that runs inside the sandbox
 * (`node -e`), next to the agent's Chromium. It speaks CDP to the browser's
 * DevTools port on the sandbox's loopback, screencasts the page the agent
 * last opened or navigated, and writes one JSON line per event to stdout:
 *
 * - `{"type":"frame","data":<base64 jpeg>,"url","title","width","height","ts"}`
 * - `{"type":"idle","reason":"not_started"}` while no browser (or no page) is there;
 *   `"reason":"no_browser"` when the sandbox has no Playwright MCP at all (its image lacks the browser).
 *
 * Each frame is acknowledged only after `AGENTRY_LIVE_INTERVAL_MS`, so
 * Chromium sends at most one frame per interval; a frame byte-identical to the
 * one before is not written. Closing stdin ends it.
 *
 * Input (take-over): stdin takes JSON lines (`RELAY_COMMAND_SOURCE`):
 * `{"type":"input","commands":[{"method","params"}]}` runs the commands on the
 * page it shows, only `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`,
 * `Input.insertText` and `Emulation.setDeviceMetricsOverride`; and
 * `{"type":"control","on":false,"resized":true,"restore":{"width","height"}}`
 * puts the page back to the size it had before the user's resize when they
 * hand control back (clearing the override instead would drop Playwright's
 * viewport too). Anything else is ignored, so stdin never
 * becomes a general DevTools channel.
 *
 * Pointer and focus (the agent's cursor): the relay installs `POINTER_LISTENER_SOURCE` in the page it shows
 * (binding `__agentryPointer`) and writes what the page's own mouse events say, so Playwright's clicks show up:
 * - `{"type":"pointer","action":"move"|"down"|"up","x","y","ts"}` (viewport CSS px; at most 30 a second, never
 *   dropping down or up),
 * - `{"type":"focus","x","y","width","height","ts"}` when a field takes focus.
 *
 * Recording (`RELAY_RECORD_SOURCE`): `{"type":"record","on":true,"path","cursorPath","maxMs","maxBytes"}` starts
 * writing what the relay shows into `path` (a `.webm` directly inside `AGENTRY_LIVE_RECORDINGS_DIR`), and
 * `{"type":"record","on":false}` stops it. Frames go to Playwright's bundled ffmpeg at a fixed 10 fps, the last
 * frame repeated so pauses keep their length; pointer and focus lines go to `cursorPath` (JSON lines, `t` in ms
 * from the first frame). The relay answers `{"type":"record","state":"started"|"stopped"|"error",...}`, and
 * stops by itself at `maxMs` or `maxBytes`, when ffmpeg ends, and before it exits.
 *
 * Configuration (environment): `AGENTRY_LIVE_CDP_PORT` (required),
 * `AGENTRY_LIVE_QUALITY`, `AGENTRY_LIVE_MAX_WIDTH`, `AGENTRY_LIVE_MAX_HEIGHT`,
 * `AGENTRY_LIVE_INTERVAL_MS`, `AGENTRY_LIVE_RECORDINGS_DIR` (absent: recording is refused),
 * `AGENTRY_LIVE_FFMPEG` (default: the first `/opt/ms-playwright/ffmpeg-*\/ffmpeg-linux`).
 */

/** Environment names the relay reads. */
export const RELAY_ENV = {
  port: 'AGENTRY_LIVE_CDP_PORT',
  quality: 'AGENTRY_LIVE_QUALITY',
  maxWidth: 'AGENTRY_LIVE_MAX_WIDTH',
  maxHeight: 'AGENTRY_LIVE_MAX_HEIGHT',
  intervalMs: 'AGENTRY_LIVE_INTERVAL_MS',
  recordingsDir: 'AGENTRY_LIVE_RECORDINGS_DIR',
  ffmpeg: 'AGENTRY_LIVE_FFMPEG',
} as const

/** Frames a second in a recording. */
export const RECORDING_FPS = 10

/**
 * ffmpeg arguments for a recording of `width` x `height` (even numbers) at `RECORDING_FPS`, checked with the
 * ffmpeg (build 1011) of `agentry-sandbox-browser:1`: JPEGs piped in (`image2pipe`, `mjpeg`), VP8 in WebM out;
 * frames of another size are scaled to fit and padded grey. Based on Playwright's own video recorder.
 */
export function recordingFfmpegArgs(width: number | string, height: number | string, fps = RECORDING_FPS): string[] {
  return [
    '-loglevel', 'error',
    '-f', 'image2pipe', '-avioflags', 'direct', '-fpsprobesize', '0', '-probesize', '32', '-analyzeduration', '0',
    '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-y', '-an', '-r', String(fps),
    '-c:v', 'vp8', '-qmin', '0', '-qmax', '50', '-crf', '8', '-deadline', 'realtime', '-speed', '8', '-b:v', '1M', '-threads', '1',
    '-vf', `scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2:gray,format=yuv420p`,
    '-f', 'webm',
  ]
}

/**
 * The relay's recording part, as JavaScript source (tested on its own with fakes):
 * - `recordCommand(line, dir)` parses a `record` stdin line (undefined for any other line); a start must name a
 *   `.webm` directly inside `dir` (letters, digits, `.`, `_`, `-`; no `..`) and the cursor file beside it
 *   (`<stem>.cursor.jsonl`), else it is `{ invalid: true }`.
 * - `createRecorder(d)` returns `{ start, frame, cursor, stop, active }`; `d` gives `fs`, `spawn`, `now`,
 *   `every`/`cancel` (intervals), `out` (a stdout line), `ffmpeg` (its path or undefined), `args(w, h)`, `fps`,
 *   `maxWidth`, `maxHeight`.
 */
export const RELAY_RECORD_SOURCE = String.raw`
function recordCommand(line, dir) {
  let msg
  try { msg = JSON.parse(line) } catch { return undefined }
  if (!msg || typeof msg !== 'object' || msg.type !== 'record') return undefined
  if (msg.on === false) return { on: false }
  const invalid = { invalid: true }
  if (msg.on !== true || typeof dir !== 'string' || typeof msg.path !== 'string') return invalid
  const base = dir.replace(/\/+$/, '')
  if (base === '' || !msg.path.startsWith(base + '/')) return invalid
  const file = msg.path.slice(base.length + 1)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.webm$/.test(file) || file.includes('..')) return invalid
  const stem = file.slice(0, -5)
  if (msg.cursorPath !== base + '/' + stem + '.cursor.jsonl') return invalid
  const lim = (v, d, max) => (Number.isInteger(v) && v > 0 && v <= max ? v : d)
  return { on: true, dir: base, stem, maxMs: lim(msg.maxMs, 900000, 3600000), maxBytes: lim(msg.maxBytes, 104857600, 104857600) }
}

function createRecorder(d) {
  let rec
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2)
  const fit = (w, h) => {
    const width = Number.isFinite(w) && w > 0 ? w : d.maxWidth
    const height = Number.isFinite(h) && h > 0 ? h : d.maxHeight
    const k = Math.min(1, d.maxWidth / width, d.maxHeight / height)
    return { width: even(width * k), height: even(height * k) }
  }
  const exists = (p) => { try { d.fs.statSync(p); return true } catch { return false } }
  const sizeOf = (p) => { try { return d.fs.statSync(p).size } catch { return 0 } }
  const fail = (code, message) => { d.out({ type: 'record', state: 'error', code, message }) }
  const note = (r, o) => { try { d.fs.appendFileSync(r.cursorPath, JSON.stringify(o) + '\n') } catch {} }

  function start(cmd) {
    if (rec) { fail('already_recording', 'a recording is already running'); return }
    const bin = d.ffmpeg()
    if (!bin) { fail('recording_unavailable', 'this sandbox has no ffmpeg for recording'); return }
    try { d.fs.mkdirSync(cmd.dir, { recursive: true }) } catch (e) { fail('recording_failed', 'cannot create ' + cmd.dir); return }
    let stem = cmd.stem
    for (let i = 2; exists(cmd.dir + '/' + stem + '.webm') || exists(cmd.dir + '/' + stem + '.cursor.jsonl'); i++) stem = cmd.stem + '-' + i
    rec = {
      bin, path: cmd.dir + '/' + stem + '.webm', cursorPath: cmd.dir + '/' + stem + '.cursor.jsonl',
      maxMs: cmd.maxMs, maxBytes: cmd.maxBytes, startedAt: d.now(), t0: undefined, proc: undefined,
      frame: undefined, view: undefined, written: 0, ticks: 0, stopping: undefined, err: '', timer: undefined,
    }
    try { d.fs.writeFileSync(rec.cursorPath, JSON.stringify({ type: 'meta', version: 1, fps: d.fps, started_at: rec.startedAt }) + '\n') } catch {}
    rec.timer = d.every(tick, Math.round(1000 / d.fps))
    d.out({ type: 'record', state: 'started', path: rec.path, cursorPath: rec.cursorPath })
  }

  function frame(data, width, height) {
    const r = rec
    if (!r || r.stopping) return
    const buf = Buffer.from(data, 'base64')
    if (!r.proc) {
      const size = fit(width, height)
      let proc
      try { proc = d.spawn(r.bin, d.args(size.width, size.height).concat([r.path])) } catch (e) { stop('ffmpeg_failed'); return }
      r.proc = proc
      r.exited = new Promise((resolve) => { proc.on('exit', resolve); proc.on('error', () => resolve(-1)) })
      proc.stdin.on('error', () => {})
      if (proc.stderr) proc.stderr.on('data', (c) => { r.err = (r.err + c).slice(-500) })
      r.exited.then(() => { if (rec === r && !r.stopping) stop('ffmpeg_exited') })
      r.t0 = d.now()
      r.view = { width, height }
      note(r, { t: 0, type: 'viewport', width, height, video_width: size.width, video_height: size.height })
    } else if (r.view && (r.view.width !== width || r.view.height !== height)) {
      r.view = { width, height }
      note(r, { t: d.now() - r.t0, type: 'viewport', width, height })
    }
    r.frame = buf
    tick()
  }

  function tick() {
    const r = rec
    if (!r || r.stopping) return
    const now = d.now()
    if (now - r.startedAt >= r.maxMs) { stop('time_limit'); return }
    if (!r.proc || !r.frame) return
    const due = Math.floor(((now - r.t0) * d.fps) / 1000) + 1
    for (let n = 0; r.written < due && n < d.fps * 5; n++) { r.proc.stdin.write(r.frame); r.written++ }
    if (r.written < due) r.written = due
    if (++r.ticks % d.fps === 0 && sizeOf(r.path) >= r.maxBytes) stop('size_limit')
  }

  function cursor(line) {
    const r = rec
    if (!r || r.stopping || r.t0 === undefined || !line) return
    const t = Math.max(0, (typeof line.ts === 'number' ? line.ts : d.now()) - r.t0)
    if (line.type === 'pointer') note(r, { t, type: 'pointer', action: line.action, x: line.x, y: line.y })
    else if (line.type === 'focus') note(r, { t, type: 'focus', x: line.x, y: line.y, width: line.width, height: line.height })
  }

  function stop(reason) {
    const r = rec
    if (!r) { fail('not_recording', 'no recording is running'); return Promise.resolve() }
    if (r.stopping) return r.stopping
    r.stopping = (async () => {
      d.cancel(r.timer)
      let code = 0
      if (r.proc) {
        try { r.proc.stdin.end() } catch {}
        let timer
        code = await Promise.race([r.exited, new Promise((resolve) => { timer = setTimeout(() => { try { r.proc.kill('SIGKILL') } catch {} resolve(-2) }, 20000) })])
        clearTimeout(timer)
      }
      if (rec === r) rec = undefined
      const bytes = r.proc ? sizeOf(r.path) : 0
      if (!r.proc) { try { d.fs.unlinkSync(r.cursorPath) } catch {} }
      d.out({
        type: 'record', state: 'stopped', reason, path: r.path, cursorPath: r.cursorPath,
        durationMs: Math.round((r.written * 1000) / d.fps), bytes, frames: r.written, empty: !r.proc,
        ...(code !== 0 && r.err ? { message: r.err.trim() } : {}),
      })
    })()
    return r.stopping
  }

  return { start, frame, cursor, stop, active: () => rec !== undefined }
}
`

/**
 * The relay's stdin command parser, as JavaScript source (it is part of the relay program and tested on its
 * own): `relayCommands(line)` returns the CDP commands to run on the shown page, never anything outside the
 * allowed methods, at most 100 a line.
 */
export const RELAY_COMMAND_SOURCE = String.raw`
function relayCommands(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return [] }
  if (!msg || typeof msg !== 'object') return []
  if (msg.type === 'control') {
    if (msg.on !== false || msg.resized !== true) return []
    const r = msg.restore
    if (r && Number.isInteger(r.width) && Number.isInteger(r.height) && r.width > 0 && r.height > 0) {
      return [{ method: 'Emulation.setDeviceMetricsOverride', params: { width: r.width, height: r.height, deviceScaleFactor: 1, mobile: false } }]
    }
    return [{ method: 'Emulation.clearDeviceMetricsOverride', params: {} }]
  }
  if (msg.type !== 'input' || !Array.isArray(msg.commands)) return []
  const allowed = ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Emulation.setDeviceMetricsOverride']
  return msg.commands
    .filter((c) => c && typeof c === 'object' && allowed.includes(c.method) && c.params && typeof c.params === 'object' && !Array.isArray(c.params))
    .slice(0, 100)
    .map((c) => ({ method: c.method, params: c.params }))
}
`

/**
 * Runs inside the page (top frame only), once per document. Reports trusted `mousemove` (one per 50 ms, latest
 * wins, trailing call kept), `mousedown`, `mouseup` and `focusin` on fields through the `__agentryPointer`
 * binding as JSON strings. Tested on its own against a fake `window`.
 */
export const POINTER_LISTENER_SOURCE = String.raw`
(function () {
  if (window.top !== window || window.__agentryPointerInstalled) return
  window.__agentryPointerInstalled = true
  var send = function (o) {
    try { if (typeof window.__agentryPointer === 'function') window.__agentryPointer(JSON.stringify(o)) } catch (e) {}
  }
  var lastMove = 0
  var timer = null
  var latest = null
  var flush = function () {
    timer = null
    if (!latest) return
    lastMove = Date.now()
    send(latest)
    latest = null
  }
  window.addEventListener('mousemove', function (e) {
    if (!e.isTrusted) return
    latest = { a: 'move', x: e.clientX, y: e.clientY }
    var wait = lastMove + 50 - Date.now()
    if (wait <= 0 && timer === null) flush()
    else if (timer === null) timer = setTimeout(flush, Math.max(0, wait))
  }, { capture: true, passive: true })
  var button = function (a) {
    return function (e) {
      if (!e.isTrusted) return
      if (timer !== null) { clearTimeout(timer); flush() }
      send({ a: a, x: e.clientX, y: e.clientY, b: e.button })
    }
  }
  window.addEventListener('mousedown', button('down'), { capture: true, passive: true })
  window.addEventListener('mouseup', button('up'), { capture: true, passive: true })
  window.addEventListener('focusin', function (e) {
    if (!e.isTrusted) return
    var t = e.target
    if (!t || typeof t.matches !== 'function' || !t.matches('input, textarea, select, [contenteditable]')) return
    var r = t.getBoundingClientRect()
    send({ a: 'focus', x: r.left, y: r.top, w: r.width, h: r.height })
  }, { capture: true, passive: true })
})()
`

/**
 * The relay's check of what the page's binding sent: `pointerLine(raw, now)` returns the line to write
 * (`pointer` or `focus`), or undefined unless it is well formed and every number is finite and within 0..100000.
 */
export const RELAY_POINTER_SOURCE = String.raw`
function pointerLine(raw, now) {
  let m
  try { m = JSON.parse(raw) } catch { return undefined }
  if (!m || typeof m !== 'object') return undefined
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000
  if (m.a === 'move' || m.a === 'down' || m.a === 'up') {
    if (!ok(m.x) || !ok(m.y)) return undefined
    return { type: 'pointer', action: m.a, x: m.x, y: m.y, ts: now }
  }
  if (m.a === 'focus') {
    if (!ok(m.x) || !ok(m.y) || !ok(m.w) || !ok(m.h)) return undefined
    return { type: 'focus', x: m.x, y: m.y, width: m.w, height: m.h, ts: now }
  }
  return undefined
}
`

/** The relay program (plain JavaScript for Node 22 or later: global `fetch` and `WebSocket`). */
export const BROWSER_LIVE_RELAY_SCRIPT = String.raw`
const env = process.env
const port = Number(env.AGENTRY_LIVE_CDP_PORT)
const quality = Number(env.AGENTRY_LIVE_QUALITY || 60)
const maxWidth = Number(env.AGENTRY_LIVE_MAX_WIDTH || 1280)
const maxHeight = Number(env.AGENTRY_LIVE_MAX_HEIGHT || 960)
const interval = Number(env.AGENTRY_LIVE_INTERVAL_MS || 250)
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n') }
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
let live = undefined
const idle = () => { if (live !== false) { live = false; out({ type: 'idle', reason: 'not_started' }) } }
const fs = require('node:fs')
const path = require('node:path')
const hasBrowser = () => (env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').some((dir) => { try { fs.accessSync(path.join(dir, 'playwright-mcp'), fs.constants.X_OK); return true } catch { return false } })
${RELAY_COMMAND_SOURCE}
${RELAY_POINTER_SOURCE}
${RELAY_RECORD_SOURCE}
const pointerSource = ${JSON.stringify(POINTER_LISTENER_SOURCE)}
const recordingsDir = env.AGENTRY_LIVE_RECORDINGS_DIR || ''
const ffmpegArgs = ${JSON.stringify(recordingFfmpegArgs('$W', '$H'))}
const findFfmpeg = () => {
  if (env.AGENTRY_LIVE_FFMPEG) return env.AGENTRY_LIVE_FFMPEG
  try {
    for (const n of fs.readdirSync('/opt/ms-playwright').filter((n) => n.startsWith('ffmpeg-')).sort().reverse()) {
      const p = '/opt/ms-playwright/' + n + '/ffmpeg-linux'
      try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
    }
  } catch {}
  return undefined
}
const recorder = createRecorder({
  fs, now: () => Date.now(), out, fps: ${String(RECORDING_FPS)}, maxWidth, maxHeight, ffmpeg: findFfmpeg,
  every: (fn, ms) => setInterval(fn, ms), cancel: (t) => clearInterval(t),
  spawn: (bin, args) => require('node:child_process').spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] }),
  args: (w, h) => ffmpegArgs.map((a) => a.replaceAll('$W', String(w)).replaceAll('$H', String(h))),
})
let shown = undefined
let lastPointerAt = 0
let run = undefined
let inbuf = ''
const finish = () => { Promise.resolve(recorder.active() ? recorder.stop('closed') : undefined).then(() => { process.exit(0) }) }
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  inbuf += chunk
  let at
  while ((at = inbuf.indexOf('\n')) >= 0) {
    const line = inbuf.slice(0, at)
    inbuf = inbuf.slice(at + 1)
    const rc = recordCommand(line, recordingsDir)
    if (rc && rc.invalid) out({ type: 'record', state: 'error', code: 'bad_record_command', message: 'a recording must be a .webm file in the workspace recordings folder' })
    else if (rc && !rc.on) void recorder.stop('stopped')
    else if (rc) {
      recorder.start(rc)
      if (shown && recorder.active()) recorder.frame(shown.data, shown.width, shown.height)
    }
    if (rc) continue
    for (const c of relayCommands(line)) if (run) run(c)
  }
})
process.stdin.on('end', finish)
process.on('SIGTERM', finish)
process.stdin.resume()

async function watch() {
  let version
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(2000) })
    version = await res.json()
  } catch { return }
  if (!version || typeof version.webSocketDebuggerUrl !== 'string') return
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    if (ws.readyState !== 1) { reject(new Error('closed')); return }
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify(sessionId ? { id, method, params: params || {}, sessionId } : { id, method, params: params || {} }))
  })
  const pages = new Map()
  let seq = 0
  let active = undefined
  let chain = Promise.resolve()
  let lastData = ''
  run = (c) => { if (active) send(c.method, c.params, active.sessionId).catch(() => {}) }
  const newest = () => { let best; for (const p of pages.values()) if (!best || p.seq > best.seq) best = p; return best }
  const follow = () => {
    chain = chain.then(async () => {
      const want = newest()
      if (active && want && active.targetId === want.targetId) return
      if (active) { const old = active; active = undefined; await send('Target.detachFromTarget', { sessionId: old.sessionId }).catch(() => {}) }
      if (!want) { idle(); return }
      const { sessionId } = await send('Target.attachToTarget', { targetId: want.targetId, flatten: true })
      active = { targetId: want.targetId, sessionId }
      lastData = ''
      // Without Page and Runtime enabled on this session, Chromium drops the binding and the new-document
      // script on the next navigation, so the cursor would only work on the page shown at attach.
      await send('Page.enable', {}, sessionId).catch(() => {})
      await send('Runtime.enable', {}, sessionId).catch(() => {})
      await send('Runtime.addBinding', { name: '__agentryPointer' }, sessionId).catch(() => {})
      await send('Page.addScriptToEvaluateOnNewDocument', { source: pointerSource }, sessionId).catch(() => {})
      await send('Runtime.evaluate', { expression: pointerSource }, sessionId).catch(() => {})
      await send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1 }, sessionId)
    }).catch(() => {})
  }
  await new Promise((resolve) => {
    ws.onopen = () => {
      send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
    }
    ws.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (p) { if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result || {}) }
        return
      }
      const params = msg.params || {}
      if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
        const t = params.targetInfo
        if (!t || t.type !== 'page') return
        const prev = pages.get(t.targetId)
        const moved = !prev || prev.url !== t.url
        pages.set(t.targetId, { targetId: t.targetId, url: t.url, title: t.title, seq: moved ? ++seq : prev.seq })
        if (moved) follow()
      } else if (msg.method === 'Target.targetDestroyed') {
        pages.delete(params.targetId)
        if (active && active.targetId === params.targetId) active = undefined
        follow()
      } else if (msg.method === 'Target.detachedFromTarget') {
        if (active && active.sessionId === params.sessionId) { active = undefined; follow() }
      } else if (msg.method === 'Runtime.bindingCalled') {
        if (!active || msg.sessionId !== active.sessionId || params.name !== '__agentryPointer') return
        const now = Date.now()
        const line = pointerLine(String(params.payload), now)
        if (!line) return
        if (line.type === 'pointer' && line.action === 'move') {
          if (now - lastPointerAt < 33) return
          lastPointerAt = now
        }
        out(line)
        recorder.cursor(line)
      } else if (msg.method === 'Page.screencastFrame') {
        const session = msg.sessionId
        setTimeout(() => { send('Page.screencastFrameAck', { sessionId: params.sessionId }, session).catch(() => {}) }, interval)
        if (!active || session !== active.sessionId) return
        const page = pages.get(active.targetId) || {}
        const meta = params.metadata || {}
        if (params.data === lastData) return
        lastData = params.data
        live = true
        out({ type: 'frame', data: params.data, url: page.url || '', title: page.title || '', width: meta.deviceWidth, height: meta.deviceHeight, ts: Date.now() })
        shown = { data: params.data, width: meta.deviceWidth, height: meta.deviceHeight }
        recorder.frame(params.data, meta.deviceWidth, meta.deviceHeight)
      }
    }
    ws.onclose = () => { run = undefined; for (const p of pending.values()) p.reject(new Error('closed')); pending.clear(); resolve() }
    ws.onerror = () => {}
  })
}

;(async () => {
  if (!Number.isInteger(port) || port <= 0) { process.stderr.write('AGENTRY_LIVE_CDP_PORT is required\n'); process.exit(2) }
  // An image without the browser never gets one: say so once and wait for stdin to close.
  if (!hasBrowser()) { out({ type: 'idle', reason: 'no_browser' }); return }
  for (;;) {
    await watch()
    idle()
    await sleep(1000)
  }
})()
`
