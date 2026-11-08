/**
 * Writes two untracked configs that point at the DSH checkout named by `DSH_ROOT`:
 * - `tsconfig.dsh.json` extends DSH's `tsconfig.base.json`, so vitest resolves DSH
 *   workspace imports to DSH sources.
 * - `tsconfig.dsh.types.json` maps the same imports to DSH's built declarations
 *   (`lib/types`), so `tsc` checks only this repository's files. DSH must have run
 *   `pnpm run build:artifacts`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = process.env['DSH_ROOT']
if (!dshRoot) {
  console.error('DSH_ROOT is not set. Point it at a checkout of the pinned DSH tag (see dsh.pin).')
  process.exit(1)
}
const base = join(resolve(dshRoot), 'tsconfig.base.json')
if (!existsSync(base)) {
  console.error(`DSH_ROOT=${dshRoot} has no tsconfig.base.json.`)
  process.exit(1)
}
const write = (name: string, value: unknown) =>
  writeFile(join(repoRoot, name), `${JSON.stringify(value, null, 2)}\n`)

const parsed = ts.parseConfigFileTextToJson(base, readFileSync(base, 'utf8'))
const sourcePaths: Record<string, string[]> = parsed.config?.compilerOptions?.paths ?? {}
const declarationPaths = Object.fromEntries(
  Object.entries(sourcePaths)
    .filter(([, targets]) => targets.every((target) => !target.split('/src')[0]!.includes('*')))
    .map(([name, targets]) => [
    name,
    targets.map((target) => {
      const absolute = join(resolve(dshRoot), target)
      const [pkgDir] = absolute.split(/\/src(?:\/|$)/)
      if (absolute.endsWith('/*')) return `${pkgDir}/lib/types/*`
      return `${pkgDir}/lib/types/index.d.ts`
    }),
  ]),
)

await write('tsconfig.dsh.json', { extends: base })
await write('tsconfig.dsh.types.json', { compilerOptions: { paths: declarationPaths } })
