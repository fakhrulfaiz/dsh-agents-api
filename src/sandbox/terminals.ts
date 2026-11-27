/**
 * Interactive terminals inside Agentry Sandbox environments: a PTY shell started
 * through envd's `process` service, kept in memory with a bounded output buffer so
 * a page reload (or a second reader) sees the recent screen. The browser never
 * gets an address into the sandbox; it reads output over SSE and sends input and
 * resizes through the API.
 */
import { randomBytes } from 'node:crypto'
import type { EnvdClient } from '@agentry/sandbox/client'

const BUFFER_BYTES = 256 * 1024
const MAX_PER_OWNER = 4
const IDLE_MS = 30 * 60 * 1000
const MAX_INPUT = 64 * 1024

export type TerminalEvent = { kind: 'output'; data: Uint8Array } | { kind: 'exit'; code: number }

export class TerminalError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
  }
}

interface Terminal {
  id: string
  owner: string
  environmentId: string
  envd: EnvdClient
  pid: number | undefined
  chunks: Uint8Array[]
  size: number
  readers: Set<(event: TerminalEvent) => void>
  exit: number | undefined
  abort: AbortController
  idleSince: number | undefined
  onStart?: { resolve(): void; reject(error: unknown): void }
}

const clamp = (n: unknown, fallback: number, max: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(2, Math.floor(n))) : fallback

export class TerminalHub {
  private readonly terminals = new Map<string, Terminal>()
  private readonly timer: NodeJS.Timeout

  constructor() {
    this.timer = setInterval(() => this.reap(), 60_000)
    this.timer.unref()
  }

  private find(owner: string, environmentId: string, id: string): Terminal {
    const t = this.terminals.get(id)
    if (!t || t.owner !== owner || t.environmentId !== environmentId) throw new TerminalError('terminal not found', 404, 'terminal_not_found')
    return t
  }

  /** Starts a shell for `owner` in the sandbox behind `envd`. */
  async open(owner: string, environmentId: string, envd: EnvdClient, opts: { cwd?: string; cols?: unknown; rows?: unknown }): Promise<string> {
    if ([...this.terminals.values()].filter((t) => t.owner === owner && t.exit === undefined).length >= MAX_PER_OWNER) {
      throw new TerminalError(`at most ${String(MAX_PER_OWNER)} terminals can be open; close one first`, 429, 'too_many_terminals')
    }
    const terminal: Terminal = {
      id: `term_${randomBytes(12).toString('hex')}`, owner, environmentId, envd, pid: undefined, chunks: [], size: 0,
      readers: new Set(), exit: undefined, abort: new AbortController(), idleSince: Date.now(),
    }
    this.terminals.set(terminal.id, terminal)
    const stream = envd.process.start(
      {
        process: {
          cmd: '/bin/bash', args: ['-l'],
          envs: { TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PROMPT_DIRTRIM: '2', ...(opts.cwd ? { PWD: opts.cwd } : {}) },
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
        },
        pty: { size: { cols: clamp(opts.cols, 80, 500), rows: clamp(opts.rows, 24, 200) } },
      },
      { headers: envd.userHeaders('agent'), signal: terminal.abort.signal },
    )
    const started = new Promise<void>((resolve, reject) => { terminal.onStart = { resolve, reject } })
    void this.pump(terminal, stream)
    await started
    return terminal.id
  }

  private async pump(terminal: Terminal, stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const res of stream) {
        const ev = (res as { event?: { event?: { case?: string; value?: unknown } } }).event?.event
        if (ev?.case === 'start') {
          terminal.pid = (ev.value as { pid: number }).pid
          terminal.onStart?.resolve()
        } else if (ev?.case === 'data') {
          const out = (ev.value as { output: { case?: string; value?: Uint8Array } }).output
          if (out.case === 'pty' && out.value) this.push(terminal, out.value)
        } else if (ev?.case === 'end') {
          this.finish(terminal, (ev.value as { exitCode: number }).exitCode)
        }
      }
      this.finish(terminal, terminal.exit ?? 0)
    } catch (error) {
      terminal.onStart?.reject(new TerminalError(`could not start a terminal: ${error instanceof Error ? error.message : String(error)}`, 502, 'terminal_unavailable'))
      this.finish(terminal, terminal.exit ?? 1)
    }
  }

  private push(terminal: Terminal, data: Uint8Array): void {
    terminal.chunks.push(data)
    terminal.size += data.byteLength
    while (terminal.size > BUFFER_BYTES && terminal.chunks.length > 1) terminal.size -= terminal.chunks.shift()!.byteLength
    for (const reader of terminal.readers) reader({ kind: 'output', data })
  }

  private finish(terminal: Terminal, code: number): void {
    // A process stream that ends before the shell started must fail the open, not leave it waiting forever.
    if (terminal.pid === undefined) {
      terminal.onStart?.reject(new TerminalError('could not start a terminal: the shell ended before it started', 502, 'terminal_unavailable'))
      this.terminals.delete(terminal.id)
    }
    if (terminal.exit !== undefined) return
    terminal.exit = code
    for (const reader of terminal.readers) reader({ kind: 'exit', code })
  }

  /** Replays the retained output, then streams live events until `signal` aborts; returns after replay with an unsubscribe. */
  attach(owner: string, environmentId: string, id: string, onEvent: (event: TerminalEvent) => void): () => void {
    const t = this.find(owner, environmentId, id)
    for (const chunk of t.chunks) onEvent({ kind: 'output', data: chunk })
    if (t.exit !== undefined) onEvent({ kind: 'exit', code: t.exit })
    t.readers.add(onEvent)
    t.idleSince = undefined
    return () => {
      t.readers.delete(onEvent)
      if (t.readers.size === 0) t.idleSince = Date.now()
    }
  }

  async input(owner: string, environmentId: string, id: string, data: unknown): Promise<void> {
    const t = this.find(owner, environmentId, id)
    if (typeof data !== 'string' || data === '') throw new TerminalError('data must be a non-empty string', 400, 'bad_request')
    const bytes = new TextEncoder().encode(data)
    if (bytes.byteLength > MAX_INPUT) throw new TerminalError('input is too large', 413, 'input_too_large')
    if (t.exit !== undefined || t.pid === undefined) throw new TerminalError('the terminal has ended', 409, 'terminal_closed')
    await t.envd.process.sendInput({ process: { selector: { case: 'pid', value: t.pid } }, input: { input: { case: 'pty', value: bytes } } }, { headers: t.envd.userHeaders('agent') })
  }

  async resize(owner: string, environmentId: string, id: string, cols: unknown, rows: unknown): Promise<void> {
    const t = this.find(owner, environmentId, id)
    if (t.exit !== undefined || t.pid === undefined) return
    await t.envd.process.update({ process: { selector: { case: 'pid', value: t.pid } }, pty: { size: { cols: clamp(cols, 80, 500), rows: clamp(rows, 24, 200) } } }, { headers: t.envd.userHeaders('agent') })
  }

  close(owner: string, environmentId: string, id: string): void {
    const t = this.find(owner, environmentId, id)
    this.dispose(t)
  }

  /** Closes every terminal of an environment (it was stopped, reset or deleted). */
  closeEnvironment(environmentId: string): void {
    for (const t of [...this.terminals.values()]) if (t.environmentId === environmentId) this.dispose(t)
  }

  private dispose(t: Terminal): void {
    t.abort.abort()
    this.finish(t, t.exit ?? 0)
    this.terminals.delete(t.id)
  }

  private reap(): void {
    const now = Date.now()
    for (const t of [...this.terminals.values()]) {
      if ((t.idleSince !== undefined && now - t.idleSince > IDLE_MS) || (t.exit !== undefined && t.readers.size === 0 && now - (t.idleSince ?? now) > 60_000)) this.dispose(t)
    }
  }

  stop(): void {
    clearInterval(this.timer)
    for (const t of [...this.terminals.values()]) this.dispose(t)
  }
}
