import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDeclarationPaths, declarationTarget } from '../scripts/dsh-paths.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('declarationTarget', () => {
  it('maps a package root, a subpath file, and a wildcard to lib/types', () => {
    const root = '/dsh'
    expect(declarationTarget(root, './packages/core/agent/src')).toBe('/dsh/packages/core/agent/lib/types/index.d.ts')
    expect(declarationTarget(root, './packages/core/agent/src/index.ts')).toBe('/dsh/packages/core/agent/lib/types/index.d.ts')
    expect(declarationTarget(root, './packages/client/ui/src/client/index.ts')).toBe('/dsh/packages/client/ui/lib/types/client/index.d.ts')
    expect(declarationTarget(root, './packages/client/ui/src/*')).toBe('/dsh/packages/client/ui/lib/types/*')
  })

  it('finds the package src segment when DSH_ROOT itself contains /src/', () => {
    expect(declarationTarget('/work/src/dsh', './packages/core/agent/src/index.ts')).toBe(
      '/work/src/dsh/packages/core/agent/lib/types/index.d.ts',
    )
  })

  it('skips targets without a src segment or with a wildcard before it', () => {
    expect(declarationTarget('/dsh', './packages/core/agent/index.ts')).toBeUndefined()
    expect(declarationTarget('/dsh', './packages/*/examples/src/index.ts')).toBeUndefined()
  })
})

describe('buildDeclarationPaths', () => {
  it('reports required aliases whose declaration file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-paths-'))
    roots.push(root)
    await mkdir(join(root, 'packages/a/lib/types'), { recursive: true })
    await writeFile(join(root, 'packages/a/lib/types/index.d.ts'), '')
    const sourcePaths = { '@x/a': ['./packages/a/src'], '@x/b': ['./packages/b/src'] }
    const result = buildDeclarationPaths(root, sourcePaths, new Set(['@x/a', '@x/b']))
    expect(result.missing).toEqual(['@x/b'])
    expect(result.paths['@x/a']).toEqual([join(root, 'packages/a/lib/types/index.d.ts')])
    expect(buildDeclarationPaths(root, sourcePaths, new Set(['@x/a'])).missing).toEqual([])
  })
})
