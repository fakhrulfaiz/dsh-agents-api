import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { bridgeConfigFromEnv, runStdioBridge, STDIN_GRACE_MS, type RemoteProcess } from '../src/sandbox/remote/stdio-bridge.ts'

/** A remote program: what the bridge writes is echoed back upper-cased; `exit` ends it. */
class FakeRemote extends Duplex implements RemoteProcess {
  stderrText = ''
  readonly exited: Promise<number | null>
  readonly received: string[] = []
  killed = 0
  private setExit!: (code: number | null) => void
  private readonly started: Promise<number>

  constructor(start: 'ok' | Error = 'ok') {
    super({ allowHalfOpen: true })
    this.exited = new Promise((r) => { this.setExit = r })
    this.started = start === 'ok' ? Promise.resolve(42) : Promise.reject(start)
    this.started.catch(() => {})
  }

  ready(): Promise<number> { return this.started }
  async kill(): Promise<void> { this.killed++; this.exit(143) }
  exit(code: number | null): void {
    if (code === null) this.destroy(new Error('relay reset'))
    else this.push(null)
    this.setExit(code)
  }

  override _read(): void {}
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.received.push(chunk.toString())
    this.push(chunk.toString().toUpperCase())
    cb()
  }
}

function io() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (d: Buffer) => { out += d.toString() })
  stderr.on('data', (d: Buffer) => { err += d.toString() })
  return { stdin, stdout, stderr, out: () => out, err: () => err }
}

describe('runStdioBridge', () => {
  it('relays bytes both ways and leaves with the program\'s exit code', async () => {
    const remote = new FakeRemote()
    const s = io()
    const done = runStdioBridge(remote, s, 'sbx_1 playwright-mcp')
    s.stdin.write('{"jsonrpc":"2.0"}\n')
    await vi.waitFor(() => { expect(s.out()).toBe('{"JSONRPC":"2.0"}\n') })
    expect(remote.received).toEqual(['{"jsonrpc":"2.0"}\n'])
    remote.exit(0)
    expect(await done).toBe(0)
    expect(s.err()).toBe('')
  })

  it('reports a non-zero exit with the program\'s stderr', async () => {
    const remote = new FakeRemote()
    remote.stderrText = 'playwright-mcp: command not found'
    const s = io()
    const done = runStdioBridge(remote, s, 'sbx_1 playwright-mcp')
    remote.exit(127)
    expect(await done).toBe(127)
    expect(s.err()).toContain('exited with 127: playwright-mcp: command not found')
  })

  it('leaves with 1 when the sandbox stream breaks', async () => {
    const remote = new FakeRemote()
    const s = io()
    const done = runStdioBridge(remote, s, 'sbx_1 x')
    remote.exit(null)
    expect(await done).toBe(1)
    expect(s.err()).toContain('the sandbox stream broke: relay reset')
  })

  it('leaves with 1 when the program never starts', async () => {
    const s = io()
    expect(await runStdioBridge(new FakeRemote(new Error('sandbox is stopped')), s, 'sbx_1 x')).toBe(1)
    expect(s.err()).toContain('could not start: sandbox is stopped')
  })

  it('stops the program a moment after the client closes stdin', async () => {
    vi.useFakeTimers()
    try {
      const remote = new FakeRemote()
      const s = io()
      const done = runStdioBridge(remote, s, 'sbx_1 x')
      s.stdin.end()
      await vi.advanceTimersByTimeAsync(STDIN_GRACE_MS - 1)
      expect(remote.killed).toBe(0)
      await vi.advanceTimersByTimeAsync(2)
      expect(remote.killed).toBe(1)
      expect(await done).toBe(143)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('bridgeConfigFromEnv', () => {
  const env = {
    AGENTRY_SANDBOX_URL: 'http://s', AGENTRY_SANDBOX_KEY: 'k', AGENTRY_BRIDGE_OWNER: 'o', AGENTRY_BRIDGE_SANDBOX_ID: 'sbx',
    AGENTRY_BRIDGE_COMMAND: '["cat","-n"]',
  }

  it('reads the command and defaults the user to agent', () => {
    expect(bridgeConfigFromEnv(env)).toEqual({ url: 'http://s', key: 'k', owner: 'o', sandboxId: 'sbx', user: 'agent', cmd: 'cat', args: ['-n'] })
  })

  it('names a missing variable', () => {
    expect(() => bridgeConfigFromEnv({ ...env, AGENTRY_SANDBOX_KEY: undefined })).toThrow('AGENTRY_SANDBOX_KEY is required')
  })

  it('refuses a command or env that is not the expected JSON', () => {
    expect(() => bridgeConfigFromEnv({ ...env, AGENTRY_BRIDGE_COMMAND: 'cat' })).toThrow('JSON array')
    expect(() => bridgeConfigFromEnv({ ...env, AGENTRY_BRIDGE_COMMAND: '[]' })).toThrow('JSON array')
    expect(() => bridgeConfigFromEnv({ ...env, AGENTRY_BRIDGE_ENV: '{"A":1}' })).toThrow('JSON object of strings')
  })
})
