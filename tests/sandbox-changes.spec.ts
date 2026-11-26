/** The sandbox changes recorder against a fake envd exec. */
import { describe, expect, it, vi } from 'vitest'
import { SandboxChanges, shadowDir, type SandboxTarget } from '../src/history/sandbox-changes.ts'

const T1 = 'a'.repeat(40)
const T2 = 'b'.repeat(40)

function fakeTarget(trees: string[], numstat = '2\t1\tsrc/a.ts\0-\t-\tlogo.png\0', diff = '@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c\n') {
  const scripts: string[] = []
  const exec = vi.fn<SandboxTarget['exec']>(async (script) => {
    scripts.push(script)
    if (script.includes('git write-tree')) return { code: 0, stdout: `${trees.shift() ?? T2}\n`, stderr: '' }
    if (script.includes('diff-tree')) return { code: 0, stdout: numstat, stderr: '' }
    if (script.includes('git diff ')) return { code: 0, stdout: diff, stderr: '' }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  })
  return { target: { dir: '/workspace', exec }, scripts, exec }
}

describe('SandboxChanges', () => {
  it('snapshots at start and end, lists changed files and serves a diff', async () => {
    const { target, scripts } = fakeTarget([T1, T2])
    const rec = new SandboxChanges({ target: async () => target, warn: vi.fn() })
    rec.start('sess_1', 'turn_3')
    rec.end('sess_1')
    expect(await rec.summary('sess_1', 'turn_3')).toEqual({
      turn: 1, total: 2, added: 2, deleted: 1,
      files: [
        { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
        { path: 'src/a.ts', display: 'src/a.ts', added: 2, deleted: 1 },
      ],
    })
    expect(scripts[0]).toContain(`git init -q --bare '${shadowDir('sess_1')}'`)
    expect(scripts[0]).toContain("GIT_WORK_TREE='/workspace'")
    expect(scripts[2]).toContain(`diff-tree -r -z --numstat --no-renames ${T1} ${T2}`)
    expect((await rec.list('sess_1')).map(entry => entry.turnId)).toEqual(['turn_3'])

    const diff = await rec.diff('sess_1', 'turn_3', 1, new AbortController().signal)
    expect(diff).toEqual({ kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', '+c'] }] })
    expect(scripts.at(-1)).toContain(`git diff --no-color --no-ext-diff --no-renames -U3 ${T1} ${T2} -- 'src/a.ts'`)
    expect(await rec.diff('sess_1', 'turn_3', 0, new AbortController().signal)).toMatchObject({ kind: 'binary' })
    expect(await rec.diff('sess_1', 'turn_3', 9, new AbortController().signal)).toBeUndefined()
  })

  it('keeps nothing when the trees match, and ignores sessions that are not on a sandbox', async () => {
    const { target } = fakeTarget([T1, T1])
    const rec = new SandboxChanges({ target: async () => target, warn: vi.fn() })
    rec.start('s', 'turn_1')
    rec.end('s')
    expect(await rec.summary('s', 'turn_1')).toBeUndefined()

    const none = new SandboxChanges({ target: async () => undefined, warn: vi.fn() })
    none.start('local', 'turn_1')
    none.end('local')
    expect(await none.list('local')).toEqual([])
  })

  it('logs one line and records nothing when git fails', async () => {
    const warn = vi.fn()
    const exec = vi.fn<SandboxTarget['exec']>(async () => ({ code: 127, stdout: '', stderr: 'git: not found' }))
    const rec = new SandboxChanges({ target: async () => ({ dir: '/workspace', exec }), warn })
    rec.start('s', 'turn_1')
    rec.end('s')
    expect(await rec.summary('s', 'turn_1')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('git: not found')
  })

  it('serves oversized for a large diff and nothing once the snapshots are gone', async () => {
    const { target, exec } = fakeTarget([T1, T2], '1\t0\tbig.txt\0', `@@ -1 +1 @@\n+${'x'.repeat(100)}\n`)
    const rec = new SandboxChanges({ target: async () => target, warn: vi.fn(), maxDiffBytes: 50 })
    rec.start('s', 'turn_1')
    rec.end('s')
    expect(await rec.diff('s', 'turn_1', 0, new AbortController().signal)).toMatchObject({ kind: 'oversized' })
    exec.mockResolvedValueOnce({ code: 128, stdout: '', stderr: 'bad object' })
    expect(await rec.diff('s', 'turn_1', 0, new AbortController().signal)).toBeUndefined()
  })
})
