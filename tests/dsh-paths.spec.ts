import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDeclarationPaths, declarationTarget, scanDshImports } from '../scripts/dsh-paths.ts'

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

  it('warns once about a skipped alias that resolves an imported specifier and stays silent for unrelated ones', () => {
    const warnings: string[] = []
    const result = buildDeclarationPaths(
      '/dsh',
      {
        '@x/flat': ['./packages/flat/index.ts'],
        '@x/unrelated/*': ['./packages/*/examples/index.ts'],
        '@x/wild/*': ['./packages/wild/src/*'],
      },
      new Set(['@x/flat', '@x/wild/sub']),
      (message) => warnings.push(message),
    )
    expect(warnings).toEqual([expect.stringContaining('@x/flat')])
    expect(result.missing).toEqual([])
  })
})

describe('scanDshImports', () => {
  it('finds dynamic and double-quoted imports in nested files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-scan-'))
    roots.push(dir)
    await mkdir(join(dir, 'nested/deep'), { recursive: true })
    await writeFile(join(dir, 'a.ts'), "import type { A } from '@deepseek-ai/dsh-a'\nimport '@deepseek-ai/dsh-side'\nexport * from '@deepseek-ai/dsh-re'\nimport x from 'left-pad'\n")
    await writeFile(join(dir, 'nested/deep/b.ts'), 'import { B } from "@deepseek-ai/dsh-b"\nconst m = await import(\'@deepseek-ai/dsh-dyn\')\n')
    expect([...scanDshImports(dir)].sort()).toEqual([
      '@deepseek-ai/dsh-a',
      '@deepseek-ai/dsh-b',
      '@deepseek-ai/dsh-dyn',
      '@deepseek-ai/dsh-re',
      '@deepseek-ai/dsh-side',
    ])
  })
})
