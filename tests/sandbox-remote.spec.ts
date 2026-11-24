/**
 * DeepSeek Harness's remote providers against a real Agentry Sandbox (Docker),
 * through EnvdSshConnection. Skipped without Docker or the runtime images
 * (`pnpm images:build` in agentry-sandbox).
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { startDockerTestService, type DockerTestService } from '@agentry/sandbox/testing'
import { z } from 'zod'
import * as runtime from '../src/sandbox/remote/plugin.ts'
import { EnvdSshConnection } from '../src/sandbox/remote/envd-ssh.ts'

function haveImages(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', 'agentry/dsh-runtime:0.2.2-rc.1', 'agentry/envd:envd-v0.6.13', 'agentry/sandbox:1'], { stdio: 'pipe', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

const OWNER = 'remote-spec'
let svc: DockerTestService
let ctx: Context
let workspace: string
let services: Context
let fiber: { dispose(): unknown } | undefined

const ready = (c: Context, names: string[]) => new Promise<Context>((resolve) => { c.inject(names, (inner) => { resolve(inner) }) })

describe.skipIf(!haveImages())('DSH remote providers over Agentry Sandbox', () => {
  beforeAll(async () => {
    svc = await startDockerTestService()
    workspace = await mkdtemp(join(tmpdir(), 'agentry-remote-'))
    const sbx = await svc.service.create(OWNER, { name: 'remote-spec', template: { workspacePath: workspace } } as never)
    ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: workspace })
    fiber = ctx.plugin(runtime, { url: svc.url, key: svc.key, owner: OWNER, sandboxId: sbx.id, workspace })
    services = await ready(ctx, ['ssh', 'fs', 'subprocess', 'sandbox', 'ptcRuntime'])
  }, 300_000)

  afterAll(async () => {
    await fiber?.dispose()
    await svc?.cleanup()
    await svc?.close()
  }, 120_000)

  it('runs a process inside the sandbox with its exit code and collected output', async () => {
    const h = services.subprocess.spawn({
      argv: ['/bin/sh', '-c', 'echo "$(whoami) $(pwd) $(cat /etc/os-release | head -1)"; echo err >&2; exit 3'],
      cwd: workspace, graceMs: 1000, env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
    })
    const outcome = await h.done
    expect(outcome.exitCode).toBe(3)
    const out = h.collected.stdout!.readFrom(0).text
    expect(out).toContain(`agent ${workspace}`)
    expect(out).toContain('Debian')
    expect(h.collected.stderr!.readFrom(0).text).toBe('err\n')
  }, 60_000)

  it('round-trips stdin', async () => {
    const h = services.subprocess.spawn({
      argv: ['/bin/cat'], cwd: workspace, graceMs: 1000, env: { PATH: '/usr/bin:/bin' },
      stdio: { stdin: { data: 'hello sandbox\n' }, stdout: { maxBytes: 65536 }, stderr: 'pipe' },
    })
    expect((await h.done).exitCode).toBe(0)
    expect(h.collected.stdout!.readFrom(0).text).toBe('hello sandbox\n')
  }, 60_000)

  it('terminate stops the process tree inside the sandbox', async () => {
    const h = services.subprocess.spawn({
      argv: ['/bin/sh', '-c', 'sleep 300 & sleep 301; wait'], cwd: workspace, graceMs: 500, env: { PATH: '/usr/bin:/bin' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    })
    await new Promise((r) => setTimeout(r, 500))
    h.terminate()
    const outcome = await h.done
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true)
    const ps = services.subprocess.spawn({
      argv: ['/bin/sh', '-c', 'ps -eo args | grep -c "^sleep 30[01]" || true'], cwd: workspace, graceMs: 500, env: { PATH: '/usr/bin:/bin' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    })
    await ps.done
    expect(ps.collected.stdout!.readFrom(0).text.trim()).toBe('0')
  }, 60_000)

  it('reads, writes, edits, lists, moves and deletes files in the sandbox workspace', async () => {
    const fs = services.fs
    const target = await fs.resolve('notes/a.txt', { cwd: workspace })
    expect(fs.processPath(target)).toBe(`${workspace}/notes/a.txt`)
    const parent = await fs.resolve(workspace)
    await fs.writeText(target, 'one\ntwo\n')
    expect(await fs.readText(target)).toBe('one\ntwo\n')
    const info = await fs.stat(target)
    expect(info).toMatchObject({ type: 'file', size: 8 })
    const edited = await fs.editText(target, { oldString: 'two', newString: 'three', replaceAll: false })
    expect(edited).toBeTruthy()
    expect(await fs.readText(target)).toBe('one\nthree\n')
    expect(new TextDecoder().decode(await fs.readByteRange(target, { offset: 4, length: 5 }))).toBe('three')
    const notes = await fs.resolve('notes', { cwd: workspace })
    expect((await fs.listDir(notes)).map((e) => e.name)).toContain('a.txt')
    const moved = await fs.resolve('notes/b.txt', { cwd: workspace })
    await fs.moveFile(target, moved, {})
    expect(await fs.stat(target)).toBeUndefined()
    expect(fs.contains(parent, moved)).toBe(true)
    await fs.deleteFile(moved)
    expect(await fs.stat(moved)).toBeUndefined()
  }, 60_000)

  it('round-trips 10 MB (write, then streamed read); whole-text and over-cap reads are refused with DSH\'s limits', async () => {
    const fs = services.fs
    const target = await fs.resolve('big.txt', { cwd: workspace })
    const big = 'x'.repeat(10 * 1024 * 1024)
    await fs.writeText(target, big)
    expect((await fs.stat(target))?.size).toBe(big.length)
    let streamed = 0
    for await (const c of await fs.streamText(target)) streamed += c.length
    expect(streamed).toBe(big.length)
    await expect(fs.readText(target)).rejects.toThrow(/whole-text transfer exceeds/)
    await expect(fs.readBytes(target, undefined, 1024)).rejects.toThrow(/exceeds the 1024-byte limit/)
  }, 120_000)

  it('runs code through the PTC runtime inside the sandbox', async () => {
    expect(services.ssh.ptcLaunch).toMatchObject({ kind: 'node-script', executable: '/opt/agentry/dsh/node' })
    const spec = services.ptcRuntime.resolve({ program: "const os = await import('node:os'); return `${os.userInfo().username}:${process.cwd()}`", bindings: [], cwd: workspace } as never)
    const result = await services.ptcRuntime.run(spec)
    expect(JSON.stringify(result)).toContain(`agent:${workspace}`)
  }, 120_000)

  it('opens a terminal inside the sandbox and resizes it', async () => {
    const t = await services.subprocess.spawnTerminal({
      argv: ['/bin/sh', '-c', 'stty size; read line; stty size; echo "got $line"'], cwd: workspace,
      env: { PATH: '/usr/bin:/bin', TERM: 'xterm' }, rows: 24, cols: 80, terminalType: 'xterm', graceMs: 500,
    })
    let out = ''
    t.output.on('data', (c: Buffer) => { out += c.toString() })
    for (let i = 0; i < 50 && !out.includes('24 80'); i++) await new Promise((r) => setTimeout(r, 100))
    await t.resize(132, 40)
    await t.write('hi\r')
    await t.done
    expect(out).toContain('24 80')
    expect(out).toContain('40 132')
    expect(out).toContain('got hi')
  }, 60_000)

  it('an unreachable service fails with a clear error; a fresh connection then works', async () => {
    const down = new Context()
    const conn = new EnvdSshConnection(down, { url: 'http://127.0.0.1:1', key: 'k', owner: OWNER, sandboxId: 'sbx_none', workspace })
    await expect(conn.request('heartbeat', {}, z.null())).rejects.toThrow(/not reachable/)
    await conn.dispose()
    expect(await services.fs.stat(await services.fs.resolve(workspace))).toMatchObject({ type: 'directory' })
  }, 60_000)

  it('the file is the one the process sees (same world)', async () => {
    const fs = services.fs
    await fs.writeText(await fs.resolve('shared.txt', { cwd: workspace }), 'from fs')
    const h = services.subprocess.spawn({
      argv: ['/bin/cat', 'shared.txt'], cwd: workspace, graceMs: 500, env: { PATH: '/usr/bin:/bin' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    })
    await h.done
    expect(h.collected.stdout!.readFrom(0).text).toBe('from fs')
  }, 60_000)
})
