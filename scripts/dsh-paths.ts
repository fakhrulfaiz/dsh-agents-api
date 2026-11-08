/**
 * Maps DSH `tsconfig.base.json` source path aliases to the declaration files that
 * `pnpm run build:artifacts` emits under each package's `lib/types`.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Converts one source alias target to its declaration target.
 *
 * @param dshRoot - Absolute DSH checkout directory.
 * @param target - Alias target from DSH's `tsconfig.base.json` (relative to `dshRoot`).
 * @returns Absolute declaration target, or `undefined` when the target has no `src` segment or a wildcard before it.
 */
export function declarationTarget(dshRoot: string, target: string): string | undefined {
  const absolute = isAbsolute(target) ? target : join(dshRoot, target)
  const segments = relative(dshRoot, absolute).split(sep)
  const srcIndex = segments.indexOf('src')
  if (srcIndex < 0) return undefined
  const pkgSegments = segments.slice(0, srcIndex)
  if (pkgSegments.some((segment) => segment.includes('*'))) return undefined
  const pkgDir = join(dshRoot, ...pkgSegments)
  const rest = segments.slice(srcIndex + 1)
  if (rest.length === 0) return join(pkgDir, 'lib', 'types', 'index.d.ts')
  const last = rest[rest.length - 1]!
  if (last !== '*') rest[rest.length - 1] = last.replace(/\.[cm]?tsx?$/, '.d.ts')
  return join(pkgDir, 'lib', 'types', ...rest)
}

/** Declaration-path mapping and the declaration files it expects but did not find. */
export interface DeclarationPaths {
  paths: Record<string, string[]>
  missing: string[]
}

/**
 * Builds the `paths` map for declaration-only type checking.
 *
 * @param dshRoot - DSH checkout directory.
 * @param sourcePaths - `compilerOptions.paths` of DSH's `tsconfig.base.json`.
 * @param required - Alias names this repository imports; their declaration files must exist.
 * @returns The mapping, plus `missing` listing required aliases whose declaration file does not exist.
 */
export function buildDeclarationPaths(
  dshRoot: string,
  sourcePaths: Record<string, string[]>,
  required: ReadonlySet<string>,
): DeclarationPaths {
  const root = resolve(dshRoot)
  const paths: Record<string, string[]> = {}
  const missing: string[] = []
  for (const [alias, targets] of Object.entries(sourcePaths)) {
    const mapped = targets.map((target) => declarationTarget(root, target))
    if (mapped.some((target) => target === undefined)) continue
    const declared = mapped as string[]
    paths[alias] = declared
    if (required.has(alias) && declared.some((file) => !existsSync(file))) missing.push(alias)
  }
  return { paths, missing }
}
