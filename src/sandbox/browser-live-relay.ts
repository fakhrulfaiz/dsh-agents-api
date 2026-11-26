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
 * Read-only: it never sends input to the page. Each frame is acknowledged
 * only after `AGENTRY_LIVE_INTERVAL_MS`, so Chromium sends at most one frame
 * per interval. Closing stdin ends it.
 *
 * Configuration (environment): `AGENTRY_LIVE_CDP_PORT` (required),
 * `AGENTRY_LIVE_QUALITY`, `AGENTRY_LIVE_MAX_WIDTH`, `AGENTRY_LIVE_MAX_HEIGHT`,
 * `AGENTRY_LIVE_INTERVAL_MS`.
 */

/** Environment names the relay reads. */
export const RELAY_ENV = {
  port: 'AGENTRY_LIVE_CDP_PORT',
  quality: 'AGENTRY_LIVE_QUALITY',
  maxWidth: 'AGENTRY_LIVE_MAX_WIDTH',
  maxHeight: 'AGENTRY_LIVE_MAX_HEIGHT',
  intervalMs: 'AGENTRY_LIVE_INTERVAL_MS',
} as const

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
process.stdin.on('end', () => { process.exit(0) })
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
  const newest = () => { let best; for (const p of pages.values()) if (!best || p.seq > best.seq) best = p; return best }
  const follow = () => {
    chain = chain.then(async () => {
      const want = newest()
      if (active && want && active.targetId === want.targetId) return
      if (active) { const old = active; active = undefined; await send('Target.detachFromTarget', { sessionId: old.sessionId }).catch(() => {}) }
      if (!want) { idle(); return }
      const { sessionId } = await send('Target.attachToTarget', { targetId: want.targetId, flatten: true })
      active = { targetId: want.targetId, sessionId }
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
      } else if (msg.method === 'Page.screencastFrame') {
        const session = msg.sessionId
        setTimeout(() => { send('Page.screencastFrameAck', { sessionId: params.sessionId }, session).catch(() => {}) }, interval)
        if (!active || session !== active.sessionId) return
        const page = pages.get(active.targetId) || {}
        const meta = params.metadata || {}
        live = true
        out({ type: 'frame', data: params.data, url: page.url || '', title: page.title || '', width: meta.deviceWidth, height: meta.deviceHeight, ts: Date.now() })
      }
    }
    ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('closed')); pending.clear(); resolve() }
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
