import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserLiveError, BrowserLiveHub, type LiveEvent, type RelayProcess } from '../src/sandbox/browser-live.ts'

class FakeRelay extends PassThrough implements RelayProcess {
  ended = false
  killed = false
  private finish!: (code: number | null) => void
  readonly exited = new Promise<number | null>((r) => { this.finish = r })
  ready = vi.fn(async () => 1)
  kill = vi.fn(async () => { this.killed = true; this.finish(null) })
  override end(...args: unknown[]): this {
    this.ended = true
    return super.end(...(args as []))
  }

  line(obj: unknown): void { this.push(`${JSON.stringify(obj)}\n`) }
  exit(code: number): void { this.finish(code) }
}

const frame = (n: number) => ({ type: 'frame', data: `jpeg${String(n)}`, url: `https://e.com/${String(n)}`, title: `T${String(n)}`, width: 1280, height: 720, ts: n })
const key = { owner: 'alice', sessionId: 'sess_1', environmentId: 'env_1' }

describe('BrowserLiveHub', () => {
  afterEach(() => { vi.useRealTimers() })

  it('starts one relay for the first reader, shares it, and replays the last frame to a new reader', async () => {
    const relays: FakeRelay[] = []
    const hub = new BrowserLiveHub({ minIntervalMs: 0 })
    const start = () => { const r = new FakeRelay(); relays.push(r); return r }
    const a: LiveEvent[] = []
    const b: LiveEvent[] = []
    hub.attach(key, start, e => a.push(e))
    relays[0]!.line(frame(1))
    await vi.waitFor(() => { expect(a).toHaveLength(1) })
    hub.attach(key, start, e => b.push(e))
    expect(relays).toHaveLength(1)
    expect(b).toEqual([{ kind: 'frame', data: 'jpeg1', url: 'https://e.com/1', title: 'T1', width: 1280, height: 720, ts: 1 }])
    relays[0]!.line({ type: 'idle', reason: 'not_started' })
    await vi.waitFor(() => { expect(b.at(-1)).toEqual({ kind: 'idle', reason: 'not_started' }) })
    expect(a.at(-1)).toEqual({ kind: 'idle', reason: 'not_started' })
    // A sandbox whose image has no browser says so.
    relays[0]!.line({ type: 'idle', reason: 'no_browser' })
    await vi.waitFor(() => { expect(a.at(-1)).toEqual({ kind: 'idle', reason: 'no_browser' }) })
    hub.stop()
  })

  it('ignores lines that are not events', async () => {
    const relay = new FakeRelay()
    const hub = new BrowserLiveHub({ minIntervalMs: 0 })
    const got: LiveEvent[] = []
    hub.attach(key, () => relay, e => got.push(e))
    relay.push('not json\n{"type":"frame"}\n{"type":"other"}\n')
    relay.line(frame(2))
    await vi.waitFor(() => { expect(got).toHaveLength(1) })
    expect(got[0]).toMatchObject({ kind: 'frame', data: 'jpeg2' })
    hub.stop()
  })

  it('caps the frame rate, keeping the newest frame', async () => {
    vi.useFakeTimers()
    const relay = new FakeRelay()
    const hub = new BrowserLiveHub({ minIntervalMs: 500 })
    const got: LiveEvent[] = []
    hub.attach(key, () => relay, e => got.push(e))
    relay.line(frame(1))
    relay.line(frame(2))
    relay.line(frame(3))
    await vi.advanceTimersByTimeAsync(10)
    expect(got.map(e => (e as { data: string }).data)).toEqual(['jpeg1'])
    await vi.advanceTimersByTimeAsync(500)
    expect(got.map(e => (e as { data: string }).data)).toEqual(['jpeg1', 'jpeg3'])
    hub.stop()
  })

  it('stops the relay a while after the last reader leaves', async () => {
    vi.useFakeTimers()
    const relays: FakeRelay[] = []
    const hub = new BrowserLiveHub({ minIntervalMs: 0, stopAfterMs: 1000 })
    const start = () => { const r = new FakeRelay(); relays.push(r); return r }
    const detach = hub.attach(key, start, () => {})
    detach()
    await vi.advanceTimersByTimeAsync(500)
    // A reader that comes back in time keeps the same relay.
    const again = hub.attach(key, start, () => {})
    await vi.advanceTimersByTimeAsync(2000)
    expect(relays).toHaveLength(1)
    expect(relays[0]!.ended).toBe(false)
    again()
    await vi.advanceTimersByTimeAsync(1000)
    expect(relays[0]!.ended).toBe(true)
    expect(relays[0]!.kill).toHaveBeenCalled()
    hub.stop()
  })

  it('restarts a relay that ended while readers remain, and says idle meanwhile', async () => {
    vi.useFakeTimers()
    const relays: FakeRelay[] = []
    const hub = new BrowserLiveHub({ minIntervalMs: 0, restartMs: 1000 })
    const got: LiveEvent[] = []
    hub.attach(key, () => { const r = new FakeRelay(); relays.push(r); return r }, e => got.push(e))
    relays[0]!.line(frame(1))
    await vi.advanceTimersByTimeAsync(1)
    relays[0]!.exit(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(got.at(-1)).toEqual({ kind: 'idle', reason: 'not_started' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(relays).toHaveLength(2)
    hub.stop()
  })

  it('limits live views per owner', () => {
    const hub = new BrowserLiveHub({ minIntervalMs: 0, maxPerOwner: 2 })
    hub.attach({ ...key, sessionId: 's1' }, () => new FakeRelay(), () => {})
    hub.attach({ ...key, sessionId: 's2' }, () => new FakeRelay(), () => {})
    // Another reader of a running view is fine.
    hub.attach({ ...key, sessionId: 's2' }, () => new FakeRelay(), () => {})
    expect(() => hub.attach({ ...key, sessionId: 's3' }, () => new FakeRelay(), () => {})).toThrow(BrowserLiveError)
    hub.attach({ ...key, owner: 'bob', sessionId: 's3' }, () => new FakeRelay(), () => {})
    hub.stop()
  })

  it('closes the views of a stopped environment', async () => {
    const relay = new FakeRelay()
    const hub = new BrowserLiveHub({ minIntervalMs: 0 })
    const got: LiveEvent[] = []
    hub.attach(key, () => relay, e => got.push(e))
    hub.closeEnvironment('env_1')
    expect(relay.kill).toHaveBeenCalled()
    // Readers hear the browser is gone, then the stream ends (they reconnect to a fresh relay).
    expect(got.slice(-2)).toEqual([{ kind: 'idle', reason: 'not_started' }, { kind: 'closed' }])
    hub.stop()
  })
})

describe('the relay program', () => {
  const runRelay = async (pathDir: string): Promise<string> => {
    const { spawn } = await import('node:child_process')
    const { BROWSER_LIVE_RELAY_SCRIPT } = await import('../src/sandbox/browser-live-relay.ts')
    const child = spawn(process.execPath, ['-e', BROWSER_LIVE_RELAY_SCRIPT], { env: { PATH: pathDir, AGENTRY_LIVE_CDP_PORT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    await vi.waitFor(() => { expect(out).toContain('\n') }, { timeout: 5000 })
    child.stdin.end()
    await new Promise((r) => { child.on('exit', r) })
    return out.trim().split('\n')[0]!
  }

  it('says the sandbox has no browser when playwright-mcp is missing', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const empty = mkdtempSync(`${tmpdir()}/relay-empty-`)
    expect(JSON.parse(await runRelay(empty))).toEqual({ type: 'idle', reason: 'no_browser' })
  })

  it('says no browser is open while nothing listens on the DevTools port', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(`${tmpdir()}/relay-bin-`)
    writeFileSync(`${dir}/playwright-mcp`, '#!/bin/sh\n', { mode: 0o755 })
    expect(JSON.parse(await runRelay(dir))).toEqual({ type: 'idle', reason: 'not_started' })
  })
})
