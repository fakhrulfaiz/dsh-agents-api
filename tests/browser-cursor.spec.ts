/** The agent's cursor in the live view: the page listener, the relay's payload check, the hub's parser and fan-out. */
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserLiveHub, parseRelayLine, type LiveEvent, type RelayProcess } from '../src/sandbox/browser-live.ts'
import { BROWSER_LIVE_RELAY_SCRIPT, POINTER_LISTENER_SOURCE, RELAY_POINTER_SOURCE } from '../src/sandbox/browser-live-relay.ts'

type Handler = (e: Record<string, unknown>) => void

function fakeWindow(top = true) {
  const handlers = new Map<string, Handler>()
  const sent: Record<string, unknown>[] = []
  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: Handler) => { handlers.set(type, fn) },
    __agentryPointer: (s: string) => { sent.push(JSON.parse(s) as Record<string, unknown>) },
  }
  win['top'] = top ? win : {}
  return { win, handlers, sent }
}

function install(win: Record<string, unknown>) {
  new Function('window', POINTER_LISTENER_SOURCE)(win)
}

describe('POINTER_LISTENER_SOURCE', () => {
  afterEach(() => { vi.useRealTimers() })

  it('reports trusted down and up always, and ignores untrusted events', () => {
    const { win, handlers, sent } = fakeWindow()
    install(win)
    handlers.get('mousedown')!({ isTrusted: true, clientX: 10, clientY: 20, button: 0 })
    handlers.get('mouseup')!({ isTrusted: true, clientX: 10, clientY: 20, button: 0 })
    handlers.get('mousedown')!({ isTrusted: false, clientX: 1, clientY: 1, button: 0 })
    expect(sent).toEqual([{ a: 'down', x: 10, y: 20, b: 0 }, { a: 'up', x: 10, y: 20, b: 0 }])
  })

  it('throttles moves to one per 50 ms, latest wins, trailing kept', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { win, handlers, sent } = fakeWindow()
    install(win)
    const move = (x: number) => handlers.get('mousemove')!({ isTrusted: true, clientX: x, clientY: 0 })
    move(1)
    move(2)
    move(3)
    expect(sent).toEqual([{ a: 'move', x: 1, y: 0 }])
    vi.advanceTimersByTime(60)
    expect(sent).toEqual([{ a: 'move', x: 1, y: 0 }, { a: 'move', x: 3, y: 0 }])
  })

  it('sends a pending move before a press', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { win, handlers, sent } = fakeWindow()
    install(win)
    handlers.get('mousemove')!({ isTrusted: true, clientX: 1, clientY: 1 })
    handlers.get('mousemove')!({ isTrusted: true, clientX: 5, clientY: 5 })
    handlers.get('mousedown')!({ isTrusted: true, clientX: 5, clientY: 5, button: 0 })
    expect(sent.map(s => s['a'])).toEqual(['move', 'move', 'down'])
  })

  it('reports focus only for fields', () => {
    const { win, handlers, sent } = fakeWindow()
    install(win)
    const target = (ok: boolean) => ({ matches: () => ok, getBoundingClientRect: () => ({ left: 5, top: 6, width: 100, height: 20 }) })
    handlers.get('focusin')!({ isTrusted: true, target: target(false) })
    handlers.get('focusin')!({ isTrusted: true, target: target(true) })
    expect(sent).toEqual([{ a: 'focus', x: 5, y: 6, w: 100, h: 20 }])
  })

  it('installs once and only in the top frame', () => {
    const frame = fakeWindow(false)
    install(frame.win)
    expect(frame.handlers.size).toBe(0)
    const { win, handlers } = fakeWindow()
    install(win)
    const first = handlers.get('mousedown')
    install(win)
    expect(handlers.get('mousedown')).toBe(first)
  })
})

describe('relay payload check', () => {
  const pointerLine = new Function(`${RELAY_POINTER_SOURCE}; return pointerLine`)() as (raw: string, now: number) => unknown

  it('maps well formed payloads', () => {
    expect(pointerLine('{"a":"down","x":1,"y":2,"b":0}', 9)).toEqual({ type: 'pointer', action: 'down', x: 1, y: 2, ts: 9 })
    expect(pointerLine('{"a":"focus","x":1,"y":2,"w":3,"h":4}', 9)).toEqual({ type: 'focus', x: 1, y: 2, width: 3, height: 4, ts: 9 })
  })

  it('drops anything else', () => {
    for (const raw of ['nope', '1', '{"a":"move","x":-1,"y":2}', '{"a":"move","x":1e9,"y":2}', '{"a":"move","x":"1","y":2}', '{"a":"focus","x":1,"y":2,"w":3}', '{"a":"zoom","x":1,"y":2}']) {
      expect(pointerLine(raw, 1)).toBeUndefined()
    }
  })
})

class FakeRelay extends PassThrough implements RelayProcess {
  readonly exited = new Promise<number | null>(() => {})
  ready = vi.fn(async () => 1)
  kill = vi.fn(async () => {})
}

describe('parseRelayLine and hub fan-out', () => {
  it('parses pointer and focus lines and rejects bad ones', () => {
    expect(parseRelayLine('{"type":"pointer","action":"move","x":1,"y":2,"ts":3}')).toEqual({ kind: 'pointer', action: 'move', x: 1, y: 2, ts: 3 })
    expect(parseRelayLine('{"type":"focus","x":1,"y":2,"width":3,"height":4,"ts":5}')).toEqual({ kind: 'focus', x: 1, y: 2, width: 3, height: 4, ts: 5 })
    expect(parseRelayLine('{"type":"pointer","action":"zoom","x":1,"y":2}')).toBeUndefined()
    expect(parseRelayLine('{"type":"pointer","action":"move","x":-1,"y":2}')).toBeUndefined()
    expect(parseRelayLine('{"type":"focus","x":1,"y":2,"width":3}')).toBeUndefined()
  })

  it('sends them to readers without storing them for new ones', async () => {
    const relay = new FakeRelay()
    const hub = new BrowserLiveHub({ minIntervalMs: 0 })
    const key = { owner: 'alice', sessionId: 's1', environmentId: 'e1' }
    const a: LiveEvent[] = []
    hub.attach(key, () => relay, e => a.push(e))
    relay.push('{"type":"pointer","action":"down","x":4,"y":5,"ts":1}\n{"type":"focus","x":1,"y":2,"width":3,"height":4,"ts":2}\n')
    await vi.waitFor(() => { expect(a).toHaveLength(2) })
    expect(a[0]).toEqual({ kind: 'pointer', action: 'down', x: 4, y: 5, ts: 1 })
    const b: LiveEvent[] = []
    hub.attach(key, () => relay, e => b.push(e))
    expect(b).toEqual([])
    hub.stop()
  })
})

describe('relay attach', () => {
  // Checked against real Chromium 2026-11-27: without both domains enabled, a navigation drops the
  // binding (Runtime) or the new-document script (Page), and the cursor stops after the first page.
  it('enables Page and Runtime before installing the binding and the new-document listener', () => {
    const at = (needle: string) => {
      const i = BROWSER_LIVE_RELAY_SCRIPT.indexOf(needle)
      expect(i, needle).toBeGreaterThan(-1)
      return i
    }
    const attach = at("send('Target.attachToTarget'")
    const page = at("send('Page.enable'")
    const runtime = at("send('Runtime.enable'")
    const binding = at("send('Runtime.addBinding'")
    const script = at("send('Page.addScriptToEvaluateOnNewDocument'")
    expect(attach).toBeLessThan(page)
    expect(attach).toBeLessThan(runtime)
    expect(Math.max(page, runtime)).toBeLessThan(Math.min(binding, script))
  })
})
