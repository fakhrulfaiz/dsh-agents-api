import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDshPin } from '../scripts/check-dsh-pin.ts'

const exec = promisify(execFile)
const roots: string[] = []

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd })
}

/** Temporary repo with two commits; the first is tagged `v-test`; `ref` is checked out. */
async function fixtureRepoAt(ref: 'v-test' | 'other-commit'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'check-dsh-pin-'))
  roots.push(dir)
  await git(dir, 'init', '-q')
  await writeFile(join(dir, 'a.txt'), 'a')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-q', '-m', 'first')
  await git(dir, 'tag', 'v-test')
  await writeFile(join(dir, 'b.txt'), 'b')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-q', '-m', 'second')
  if (ref === 'v-test') await git(dir, 'checkout', '-q', 'v-test')
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('checkDshPin', () => {
  it('fails when DSH_ROOT HEAD is not the pinned tag commit', async () => {
    const result = await checkDshPin({ dshRoot: await fixtureRepoAt('other-commit'), pin: 'v-test' })
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('v-test') })
  })

  it('passes when DSH_ROOT HEAD equals the pinned tag commit', async () => {
    expect(await checkDshPin({ dshRoot: await fixtureRepoAt('v-test'), pin: 'v-test' })).toEqual({ ok: true })
  })

  it('fails with the pin name when the tag does not exist', async () => {
    const result = await checkDshPin({ dshRoot: await fixtureRepoAt('v-test'), pin: 'v-missing' })
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('v-missing') })
  })
})
