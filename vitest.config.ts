import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig, type Plugin } from 'vitest/config'

const dshRoot = process.env['DSH_ROOT']
if (!dshRoot) throw new Error('DSH_ROOT is not set. Run `export DSH_ROOT=/path/to/dsh-pinned` (a checkout of the tag in dsh.pin).')

// DSH sources use standard decorators, which Vite's parser cannot read; DSH's own
// test configuration transforms them with this shared plugin.
const { standardDecoratorPlugin } = (await import(pathToFileURL(resolve(dshRoot, 'vitest.shared.ts')).href)) as {
  standardDecoratorPlugin: () => Plugin
}

export default defineConfig({
  // `tsconfig.dsh.json` extends DSH's tsconfig.base.json, which has no `include`:
  // the plugin applies its `paths` to every file, including this repository's tests.
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['./tsconfig.dsh.json'] })],
  test: { include: ['tests/**/*.spec.ts'] },
})
