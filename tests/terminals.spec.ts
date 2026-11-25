import { describe, expect, it } from 'vitest'
import { TerminalHub, type TerminalEvent } from '../src/sandbox/terminals.ts'

function fakeEnvd() {
  const calls = { input: [] as unknown[], update: [] as unknown[], start: [] as unknown[] }
  let push: (res: unknown) => void = () => {}
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  push = (res) => { queue.push(res); wake?.() }
  async function* stream() {
    for (;;) {
      while (queue.length > 0) {
        const res = queue.shift()
        yield res
        if ((res as { event: { event: { case: string } } }).event.event.case === 'end') return
      }
      await new Promise<void>((r) => { wake = r })
    }
  }
  const envd = {
    userHeaders: () => ({}),
    process: {
      start: (req: unknown) => { calls.start.push(req); push({ event: { event: { case: 'start', value: { pid: 42 } } } }); return stream() },
      sendInput: async (req: unknown) => { calls.input.push(req) },
      update: async (req: unknown) => { calls.update.push(req) },
    },
  }
  const out = (text: string) => push({ event: { event: { case: 'data', value: { output: { case: 'pty', value: new TextEncoder().encode(text) } } } } })
  const end = (exitCode: number) => push({ event: { event: { case: 'end', value: { exitCode } } } })
  return { envd: envd as never, calls, out, end }
}

describe('TerminalHub', () => {
  it('opens a PTY shell, replays the buffer to a late reader, forwards input and resize, ends', async () => {
    const hub = new TerminalHub()
    const f = fakeEnvd()
    const id = await hub.open('o', 'env_1', f.envd, { cwd: '/w', cols: 100, rows: 30 })
    expect(f.calls.start[0]).toMatchObject({ process: { cmd: '/bin/bash', cwd: '/w' }, pty: { size: { cols: 100, rows: 30 } } })
    f.out('hello ')
    f.out('world')
    await new Promise((r) => setTimeout(r, 10))
    const seen: TerminalEvent[] = []
    hub.attach('o', 'env_1', id, (e) => seen.push(e))
    expect(seen.map((e) => (e.kind === 'output' ? new TextDecoder().decode(e.data) : 'exit')).join('')).toBe('hello world')
    await hub.input('o', 'env_1', id, 'ls\n')
    expect(f.calls.input[0]).toMatchObject({ process: { selector: { case: 'pid', value: 42 } }, input: { input: { case: 'pty' } } })
    await hub.resize('o', 'env_1', id, 120, 40)
    expect(f.calls.update[0]).toMatchObject({ pty: { size: { cols: 120, rows: 40 } } })
    f.end(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(seen.at(-1)).toEqual({ kind: 'exit', code: 0 })
    await expect(hub.input('o', 'env_1', id, 'x')).rejects.toMatchObject({ status: 409 })
    hub.stop()
  })

  it('scopes terminals to their owner and environment, caps them, and closes by environment', async () => {
    const hub = new TerminalHub()
    const id = await hub.open('o', 'env_1', fakeEnvd().envd, {})
    expect(() => hub.attach('other', 'env_1', id, () => {})).toThrowError(/not found/)
    expect(() => hub.attach('o', 'env_2', id, () => {})).toThrowError(/not found/)
    for (let i = 0; i < 3; i += 1) await hub.open('o', 'env_1', fakeEnvd().envd, {})
    await expect(hub.open('o', 'env_1', fakeEnvd().envd, {})).rejects.toMatchObject({ status: 429 })
    hub.closeEnvironment('env_1')
    expect(() => hub.attach('o', 'env_1', id, () => {})).toThrowError(/not found/)
    hub.stop()
  })
})
