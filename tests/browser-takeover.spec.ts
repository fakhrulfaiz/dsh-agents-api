/** Browser take-over: input checks and CDP mapping, the relay's stdin commands, hub control, and the agent's tool gate. */
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserLiveError, BrowserLiveHub, type LiveEvent, type RelayProcess } from '../src/sandbox/browser-live.ts'
import { MAX_INPUT_EVENTS, parseInputEvents, toCdpCommand } from '../src/sandbox/browser-input.ts'
import { RELAY_COMMAND_SOURCE } from '../src/sandbox/browser-live-relay.ts'
import { HANDED_BACK_NOTE, browserLookNote, browserToolGate } from '../src/sandbox/browser-control.ts'

class FakeRelay extends PassThrough implements RelayProcess {
  readonly lines: unknown[] = []
  private finish!: (code: number | null) => void
  readonly exited = new Promise<number | null>((r) => { this.finish = r })
  ready = vi.fn(async () => 1)
  kill = vi.fn(async () => { this.finish(null) })
  override write(chunk: unknown): boolean {
    for (const line of String(chunk).split('\n')) if (line) this.lines.push(JSON.parse(line))
    return true
  }

  frame(n: number, data = `jpeg${String(n)}`): void { this.push(`${JSON.stringify({ type: 'frame', data, url: 'https://e.com/', title: 'T', width: 1280, height: 720, ts: n })}\n`) }
}

const key = { owner: 'alice', sessionId: 'sess_1', environmentId: 'env_1' }
const click = [{ type: 'mouse', action: 'down', x: 10, y: 20 }] as const

function setup(options: ConstructorParameters<typeof BrowserLiveHub>[0] = {}) {
  const relay = new FakeRelay()
  const hub = new BrowserLiveHub({ minIntervalMs: 0, ...options })
  const got: LiveEvent[] = []
  const detach = hub.attach(key, () => relay, e => got.push(e))
  return { relay, hub, got, detach }
}

afterEach(() => { vi.useRealTimers() })

describe('browser input events', () => {
  it('maps mouse, wheel, keys, text and resize to CDP in CSS pixels', () => {
    const events = parseInputEvents([
      { type: 'mouse', action: 'move', x: 5.5, y: 6 },
      { type: 'mouse', action: 'down', x: 5, y: 6, button: 'left', click_count: 1 },
      { type: 'mouse', action: 'up', x: 5, y: 6, button: 'left', modifiers: 8 },
      { type: 'wheel', x: 1, y: 2, delta_x: 0, delta_y: 120 },
      { type: 'key', action: 'down', key: 'a', code: 'KeyA', key_code: 65, text: 'a' },
      { type: 'key', action: 'down', key: 'Backspace', code: 'Backspace', key_code: 8 },
      { type: 'key', action: 'up', key: 'a', code: 'KeyA', key_code: 65 },
      { type: 'text', text: 'héllo' },
      { type: 'resize', width: 99999, height: 10 },
    ])
    expect(Array.isArray(events)).toBe(true)
    expect((events as never[]).map(toCdpCommand)).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 5.5, y: 6, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 5, y: 6, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 5, y: 6, button: 'left', buttons: 0, clickCount: 1, modifiers: 8 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 120, modifiers: 0 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0, text: 'a', unmodifiedText: 'a' } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0 } },
      { method: 'Input.insertText', params: { text: 'héllo' } },
      { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1920, height: 240, deviceScaleFactor: 1, mobile: false } },
    ])
  })

  it('rejects malformed events and oversized batches', () => {
    expect(parseInputEvents([])).toMatch(/non-empty/)
    expect(parseInputEvents('x')).toMatch(/non-empty/)
    expect(parseInputEvents(Array.from({ length: MAX_INPUT_EVENTS + 1 }, () => click[0]))).toMatch(/at most/)
    expect(parseInputEvents([{ type: 'mouse', action: 'drag', x: 1, y: 1 }])).toMatch(/events\[0]/)
    expect(parseInputEvents([{ type: 'mouse', action: 'down', x: 1, y: 1, button: 'back' }])).toMatch(/events\[0]/)
    expect(parseInputEvents([{ type: 'key', action: 'down', key: '' }])).toMatch(/events\[0]/)
    expect(parseInputEvents([{ type: 'text', text: 'x'.repeat(5000) }])).toMatch(/events\[0]/)
    expect(parseInputEvents([{ type: 'cdp', method: 'Runtime.evaluate' }])).toMatch(/events\[0]/)
  })
})

describe('relay stdin commands', () => {
  const relayCommands = new Function(`${RELAY_COMMAND_SOURCE}; return relayCommands`)() as (line: string) => { method: string; params: unknown }[]

  it('passes only input and page-size commands through', () => {
    const line = JSON.stringify({ type: 'input', commands: [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 1, y: 2 } },
      { method: 'Runtime.evaluate', params: { expression: 'alert(1)' } },
      { method: 'Input.insertText', params: { text: 'hi' } },
      { method: 'Input.dispatchKeyEvent', params: 'bad' },
      { method: 'Emulation.setDeviceMetricsOverride', params: { width: 800, height: 600 } },
    ] })
    expect(relayCommands(line).map(c => c.method)).toEqual(['Input.dispatchMouseEvent', 'Input.insertText', 'Emulation.setDeviceMetricsOverride'])
  })

  it('restores the page size on hand-back only after a resize, and ignores anything else', () => {
    expect(relayCommands('{"type":"control","on":false,"resized":true,"restore":{"width":1280,"height":720}}')).toEqual([
      { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false } },
    ])
    expect(relayCommands('{"type":"control","on":false,"resized":true}')).toEqual([{ method: 'Emulation.clearDeviceMetricsOverride', params: {} }])
    expect(relayCommands('{"type":"control","on":false}')).toEqual([])
    expect(relayCommands('not json')).toEqual([])
    expect(relayCommands('{"type":"cdp","method":"Input.insertText","params":{}}')).toEqual([])
    const many = JSON.stringify({ type: 'input', commands: Array.from({ length: 150 }, () => ({ method: 'Input.insertText', params: { text: 'a' } })) })
    expect(relayCommands(many)).toHaveLength(100)
  })
})

describe('BrowserLiveHub frames', () => {
  it('drops a frame identical to the last one sent', async () => {
    const { relay, hub, got } = setup()
    relay.frame(1, 'same')
    relay.frame(2, 'same')
    relay.frame(3, 'other')
    await vi.waitFor(() => { expect(got).toHaveLength(2) })
    expect(got.map(e => (e as { data: string }).data)).toEqual(['same', 'other'])
    hub.stop()
  })
})

describe('BrowserLiveHub control', () => {
  it('takes control for a watched view, tells readers, and sends input through the relay', () => {
    const { relay, hub, got } = setup()
    const grant = hub.takeControl('alice', 'sess_1')
    expect(grant.controlId).toMatch(/^bctl_/)
    expect(hub.controlled('sess_1')).toBe(true)
    expect(got.at(-1)).toEqual({ kind: 'control', controlled: true, since: grant.since })
    hub.input('alice', 'sess_1', grant.controlId, parseInputEvents([...click]) as never)
    expect(relay.lines).toEqual([{ type: 'input', commands: [toCdpCommand({ type: 'mouse', action: 'down', x: 10, y: 20 })] }])
    // A new reader learns that the user has control.
    const late: LiveEvent[] = []
    hub.attach(key, () => relay, e => late.push(e))
    expect(late).toContainEqual({ kind: 'control', controlled: true, since: grant.since })
    expect(hub.releaseControl('alice', 'sess_1', grant.controlId)).toBe(true)
    expect(got.at(-1)).toEqual({ kind: 'control', controlled: false, reason: 'released' })
    expect(hub.handedBackSince('sess_1')).toBe(true)
    hub.stop()
  })

  it('needs a reader, keeps other owners out, and locks control to one grant', () => {
    const hub = new BrowserLiveHub({ minIntervalMs: 0 })
    expect(() => hub.takeControl('alice', 'sess_1')).toThrow(expect.objectContaining({ status: 409, code: 'browser_not_live' }))
    const { hub: h } = setup()
    expect(() => h.takeControl('bob', 'sess_1')).toThrow(expect.objectContaining({ status: 404 }))
    const first = h.takeControl('alice', 'sess_1')
    expect(() => h.takeControl('alice', 'sess_1')).toThrow(expect.objectContaining({ status: 409, code: 'browser_control_held' }))
    expect(() => h.input('bob', 'sess_1', first.controlId, [click[0]] as never)).toThrow(expect.objectContaining({ code: 'not_in_control' }))
    const second = h.takeControl('alice', 'sess_1', true)
    expect(() => h.input('alice', 'sess_1', first.controlId, [click[0]] as never)).toThrow(expect.objectContaining({ code: 'not_in_control' }))
    // The older tab's release does not end the newer grant.
    expect(h.releaseControl('alice', 'sess_1', first.controlId)).toBe(false)
    expect(h.controlled('sess_1')).toBe(true)
    expect(h.releaseControl('alice', 'sess_1', second.controlId)).toBe(true)
    // Watching without input is not a hand-back the agent must hear about.
    expect(h.handedBackSince('sess_1')).toBe(false)
    h.stop()
  })

  it('rate-limits input per second', () => {
    vi.useFakeTimers()
    const { hub } = setup({ maxInputPerSecond: 3 })
    const { controlId } = hub.takeControl('alice', 'sess_1')
    const two = [click[0], click[0]] as never
    hub.input('alice', 'sess_1', controlId, two)
    let error: unknown
    try { hub.input('alice', 'sess_1', controlId, two) } catch (e) { error = e }
    expect(error).toBeInstanceOf(BrowserLiveError)
    expect(error).toMatchObject({ status: 429, code: 'input_rate_limited' })
    vi.advanceTimersByTime(1000)
    hub.input('alice', 'sess_1', controlId, two)
    hub.stop()
  })

  it('ends control after the idle time without input', () => {
    vi.useFakeTimers()
    const { hub, got } = setup({ controlIdleMs: 1000 })
    const { controlId } = hub.takeControl('alice', 'sess_1')
    vi.advanceTimersByTime(800)
    hub.input('alice', 'sess_1', controlId, [click[0]] as never)
    vi.advanceTimersByTime(800)
    expect(hub.controlled('sess_1')).toBe(true)
    vi.advanceTimersByTime(300)
    expect(hub.controlled('sess_1')).toBe(false)
    expect(got.at(-1)).toEqual({ kind: 'control', controlled: false, reason: 'idle' })
    hub.stop()
  })

  it('ends control shortly after the last reader leaves, but not on a quick reconnect', () => {
    vi.useFakeTimers()
    const { relay, hub, detach } = setup({ controlLeaveMs: 500 })
    hub.takeControl('alice', 'sess_1')
    detach()
    vi.advanceTimersByTime(300)
    const again = hub.attach(key, () => relay, () => {})
    vi.advanceTimersByTime(1000)
    expect(hub.controlled('sess_1')).toBe(true)
    again()
    vi.advanceTimersByTime(600)
    expect(hub.controlled('sess_1')).toBe(false)
    hub.stop()
  })

  it('restores the page size on hand-back after a resize, and ends control with the environment', async () => {
    const { relay, hub, got } = setup()
    relay.frame(1)
    await vi.waitFor(() => { expect(got).toHaveLength(1) })
    const { controlId } = hub.takeControl('alice', 'sess_1')
    hub.input('alice', 'sess_1', controlId, [{ type: 'resize', width: 800, height: 600 }])
    hub.closeEnvironment('env_1')
    expect(relay.lines.at(-1)).toEqual({ type: 'control', on: false, resized: true, restore: { width: 1280, height: 720 } })
    expect(got).toContainEqual({ kind: 'control', controlled: false, reason: 'closed' })
    expect(hub.controlled('sess_1')).toBe(false)
  })
})

describe('browser tool gate', () => {
  it('lets other tools and an uncontrolled browser run', async () => {
    const { hub } = setup()
    expect(await browserToolGate(hub, 'sess_1', 'mcp__browser__browser_click')).toEqual({ kind: 'allow' })
    hub.takeControl('alice', 'sess_1')
    expect(await browserToolGate(hub, 'sess_1', 'shell')).toEqual({ kind: 'allow' })
    hub.stop()
  })

  it('makes a browser call wait while the user has control, then answers the hand-back note', async () => {
    const { hub } = setup()
    const { controlId } = hub.takeControl('alice', 'sess_1')
    hub.input('alice', 'sess_1', controlId, [click[0]] as never)
    let settled = false
    const gate = browserToolGate(hub, 'sess_1', 'mcp__browser__browser_click').then((d) => { settled = true; return d })
    await new Promise(r => setTimeout(r, 20))
    expect(settled).toBe(false)
    hub.releaseControl('alice', 'sess_1', controlId)
    expect(await gate).toEqual({ kind: 'deny', reason: HANDED_BACK_NOTE })
    // Until the agent looks again, actions answer the note; a look runs and carries it.
    expect(await browserToolGate(hub, 'sess_1', 'mcp__browser__browser_type')).toEqual({ kind: 'deny', reason: HANDED_BACK_NOTE })
    expect(await browserToolGate(hub, 'sess_1', 'mcp__browser__browser_snapshot')).toEqual({ kind: 'allow' })
    expect(browserLookNote(hub, 'sess_1', 'mcp__browser__browser_snapshot', false)).toBe(HANDED_BACK_NOTE)
    expect(browserLookNote(hub, 'sess_1', 'mcp__browser__browser_snapshot', false)).toBeUndefined()
    expect(await browserToolGate(hub, 'sess_1', 'mcp__browser__browser_type')).toEqual({ kind: 'allow' })
    hub.stop()
  })

  it('runs the waiting call as usual when the user only watched, and cancels it when the turn stops', async () => {
    const { hub } = setup()
    const { controlId } = hub.takeControl('alice', 'sess_1')
    const watched = browserToolGate(hub, 'sess_1', 'mcp__browser__browser_click')
    hub.releaseControl('alice', 'sess_1', controlId)
    expect(await watched).toEqual({ kind: 'allow' })
    hub.takeControl('alice', 'sess_1')
    const abort = new AbortController()
    const stopped = browserToolGate(hub, 'sess_1', 'mcp__browser__browser_click', abort.signal)
    abort.abort()
    expect(await stopped).toEqual({ kind: 'cancel' })
    hub.stop()
  })

  it('releases a waiting call when control times out', async () => {
    vi.useFakeTimers()
    const { hub } = setup({ controlIdleMs: 1000 })
    hub.takeControl('alice', 'sess_1')
    const gate = browserToolGate(hub, 'sess_1', 'mcp__browser__browser_navigate')
    await vi.advanceTimersByTimeAsync(1001)
    expect(await gate).toEqual({ kind: 'allow' })
    hub.stop()
  })
})
