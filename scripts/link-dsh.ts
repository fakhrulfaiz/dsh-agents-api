/**
 * Writes two untracked configs that point at the DSH checkout named by `DSH_ROOT`:
 * - `tsconfig.dsh.json` extends DSH's `tsconfig.base.json`, so vitest resolves DSH
 *   workspace imports to DSH sources.
 * - `tsconfig.dsh.types.json` maps the same imports to DSH's built declarations
 *   (`lib/types`), so `tsc` checks only this repository's files. DSH must have run
 *   `pnpm run build:artifacts`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildDeclarationPaths } from './dsh-paths.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = process.env['DSH_ROOT']
if (!dshRoot) {
  console.error('DSH_ROOT is not set. Run `export DSH_ROOT=/path/to/dsh-pinned` (a checkout of the tag in dsh.pin).')
  process.exit(1)
}
const base = join(resolve(dshRoot), 'tsconfig.base.json')
if (!existsSync(base)) {
  console.error(`DSH_ROOT=${dshRoot} has no tsconfig.base.json.`)
  process.exit(1)
}
const write = (name: string, value: unknown) =>
  writeFile(join(repoRoot, name), `${JSON.stringify(value, null, 2)}\n`)

const srcDir = join(repoRoot, 'src')
const imported = new Set<string>()
for (const file of readdirSync(srcDir).filter((name) => name.endsWith('.ts'))) {
  for (const match of readFileSync(join(srcDir, file), 'utf8').matchAll(/from '(@deepseek-ai\/[^']+)'/g)) {
    imported.add(match[1]!)
  }
}

const parsed = ts.parseConfigFileTextToJson(base, readFileSync(base, 'utf8'))
const sourcePaths: Record<string, string[]> = parsed.config?.compilerOptions?.paths ?? {}
const { paths, missing } = buildDeclarationPaths(dshRoot, sourcePaths, imported)
if (missing.length > 0) {
  console.error(`DSH declarations are missing for ${missing.join(', ')}. Run \`pnpm run build:artifacts\` in ${dshRoot}.`)
  process.exit(1)
}

await write('tsconfig.dsh.json', { extends: base })
await write('tsconfig.dsh.types.json', { compilerOptions: { paths } })
