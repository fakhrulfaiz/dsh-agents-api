/**
 * One envd process as a Node byte stream: writes become `SendInput` calls (in
 * order, coalesced, at most 1 MiB each), `end()` closes stdin, and the
 * process's stdout is the readable side. stderr is kept (bounded) for
 * diagnostics. Used by EnvdSshConnection for the DSH helper's RPC channel and
 * for each forwarded program stream.
 */
import { Duplex } from 'node:stream'
import type { EnvdClient } from '@agentry/sandbox/client'

export interface EnvdProcessSpec {
  cmd: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  user: string
}

const MAX_INPUT = 1024 * 1024
const MAX_STDERR = 16 * 1024
const KILL_TIMEOUT_MS = 5_000
const SIGKILL = 9
const SIGTERM = 15

export class EnvdProcessStream extends Duplex {
  pid: number | undefined
  stderrText = ''
  /** Resolves with the exit code once the process ends (null when the stream broke first). */
  readonly exited: Promise<number | null>
  private readonly started: Promise<number>
  private readonly controller = new AbortController()
  private resumeRead: (() => void) | undefined
  private setExit!: (code: number | null) => void

  constructor(private readonly envd: EnvdClient, private readonly spec: EnvdProcessSpec, signal?: AbortSignal) {
    super({ allowHalfOpen: true })
    this.exited = new Promise((r) => { this.setExit = r })
    if (signal) {
      if (signal.aborted) this.controller.abort(signal.reason)
      else signal.addEventListener('abort', () => { this.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))) }, { once: true })
    }
    let markStarted!: (pid: number) => void
    let failStart!: (e: Error) => void
    this.started = new Promise<number>((res, rej) => { markStarted = res; failStart = rej })
    this.started.catch(() => {})
    void this.pump(markStarted, failStart)
  }

  /** The pid once envd reports the process started; rejects if it never starts. */
  ready(): Promise<number> {
    return this.started
  }

  private async pump(markStarted: (pid: number) => void, failStart: (e: Error) => void): Promise<void> {
    let code: number | null = null
    try {
      const stream = this.envd.process.start(
        { process: { cmd: this.spec.cmd, args: this.spec.args, envs: this.spec.env ?? {}, ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}) }, stdin: true },
        { headers: this.envd.userHeaders(this.spec.user), signal: this.controller.signal },
      )
      for await (const res of stream) {
        const ev = res.event?.event
        if (ev?.case === 'start') {
          this.pid = ev.value.pid
          markStarted(ev.value.pid)
        } else if (ev?.case === 'data') {
          const out = ev.value.output
          if (out.case === 'stdout' && out.value.length > 0) {
            if (!this.push(Buffer.from(out.value))) await new Promise<void>((r) => { this.resumeRead = r })
            if (this.destroyed) return
          } else if (out.case === 'stderr' && this.stderrText.length < MAX_STDERR) {
            this.stderrText += Buffer.from(out.value).toString('utf8').slice(0, MAX_STDERR - this.stderrText.length)
          }
        } else if (ev?.case === 'end') {
          code = ev.value.exitCode
        }
      }
      failStart(new Error(`envd process ${this.spec.cmd} ended before it started${this.stderrText ? `: ${this.stderrText.trim()}` : ''}`))
      this.setExit(code)
      this.push(null)
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      failStart(error)
      this.setExit(null)
      if (!this.destroyed) this.destroy(error)
    }
  }

  override _read(): void {
    const r = this.resumeRead
    this.resumeRead = undefined
    r?.()
  }

  private async send(bytes: Uint8Array): Promise<void> {
    const pid = await this.started
    for (let at = 0; at < bytes.length; at += MAX_INPUT) {
      await this.envd.process.sendInput(
        { process: { selector: { case: 'pid', value: pid } }, input: { input: { case: 'stdin', value: bytes.subarray(at, at + MAX_INPUT) } } },
        { headers: this.envd.userHeaders(this.spec.user), signal: this.controller.signal },
      )
    }
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.send(chunk).then(() => { cb() }, (e: unknown) => { cb(e as Error) })
  }

  override _writev(chunks: { chunk: Buffer }[], cb: (e?: Error | null) => void): void {
    this.send(Buffer.concat(chunks.map((c) => c.chunk))).then(() => { cb() }, (e: unknown) => { cb(e as Error) })
  }

  override _final(cb: (e?: Error | null) => void): void {
    this.started
      .then((pid) => this.envd.process.closeStdin({ process: { selector: { case: 'pid', value: pid } } }, { headers: this.envd.userHeaders(this.spec.user), signal: this.controller.signal }))
      .then(() => { cb() }, (e: unknown) => { cb(e as Error) })
  }

  /** Signal the process (SIGTERM, or SIGKILL when `force`); a process that already ended is not an error. */
  async kill(force = false): Promise<void> {
    const pid = this.pid
    if (pid === undefined) return
    // Bounded: a sandbox that stopped answering must not hold the stream open.
    await this.envd.process.sendSignal({ process: { selector: { case: 'pid', value: pid } }, signal: force ? SIGKILL : SIGTERM }, { headers: this.envd.userHeaders(this.spec.user), signal: AbortSignal.timeout(KILL_TIMEOUT_MS) }).catch(() => {})
  }

  override _destroy(error: Error | null, cb: (e?: Error | null) => void): void {
    // Before `start` there is no pid to signal: abort the Start call at once.
    if (this.pid === undefined) this.controller.abort(error ?? new Error('stream closed'))
    void this.kill(true).finally(() => { this.controller.abort(error ?? new Error('stream closed')) })
    this.resumeRead?.()
    cb(error)
  }
}
