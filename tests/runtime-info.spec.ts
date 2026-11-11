import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRuntimeInfo } from '../src/environment/runtime-info.ts'

describe('readRuntimeInfo', () => {
  it('reads the bundled versions and Python packages from runtime.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-'))
    const path = join(dir, 'runtime.json')
    await writeFile(path, JSON.stringify({ node: '24.21.0', python: '3.12.14', pnpm: '11.28.5', platform: 'linux', pythonPackages: { pandas: '3.0.1', bad: 7 } }))
    expect(await readRuntimeInfo(path)).toEqual({
      object: 'sandbox.runtimes', available: true, node: '24.21.0', python: '3.12.14', pnpm: '11.28.5', platform: 'linux', python_packages: { pandas: '3.0.1' },
    })
  })

  it('reports unavailable when nothing is configured or the file is missing or broken', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-'))
    await writeFile(join(dir, 'broken.json'), '{')
    expect(await readRuntimeInfo(undefined)).toEqual({ object: 'sandbox.runtimes', available: false })
    expect(await readRuntimeInfo(join(dir, 'missing.json'))).toEqual({ object: 'sandbox.runtimes', available: false })
    expect(await readRuntimeInfo(join(dir, 'broken.json'))).toEqual({ object: 'sandbox.runtimes', available: false })
  })
})
