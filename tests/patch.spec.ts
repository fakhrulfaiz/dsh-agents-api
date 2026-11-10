/** The experimental Agents API package's declared profile patch. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import '../src/index.ts'

describe('dsh-agents-api bundle', () => {
  it('registers agents-api on the profile webserver without inserting a second one', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({ busboy: expect.any(String), jose: expect.any(String), pg: expect.any(String) })
    const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('- id: webserver')
    expect(patch).toContain('id: agents-api')
    expect(patch).toContain("name: '@agentry/api'")
    expect(patch).toContain("prefix: '/v1'")
    expect(patch).toContain('mode: development')
    expect(patch).toContain('!!js process.env.AGENTRY_DEV_KEY')
    expect(patch).toContain('url: !!js process.env.AGENTRY_DATABASE_URL')
    expect(patch).toMatch(/- id: skill-office\n\s+name: '@deepseek-ai\/dsh-skill-office'/u)
  })

  it.skipIf(process.env['DSH_ROOT'] === undefined)('inherits the command registry and the /compact, /goal, /feedback definitions from the pinned bundles', () => {
    const bundles = resolve(process.env['DSH_ROOT']!, 'packages/bundle')
    const read = (path: string) => readFileSync(resolve(bundles, path), 'utf8')
    const base = read('base/cordis.patch.yml')
    expect(base).toContain("name: '@deepseek-ai/dsh-commands'")
    expect(base).toContain("name: '@deepseek-ai/dsh-command-feedback'")
    // The web-app bundle disables the global goal and compact rows; each preset mounts them per agent.
    const standard = read('web-app/presets/standard.patch.yml')
    expect(standard).toContain("name: '@deepseek-ai/dsh-command-goal'")
    expect(standard).toContain("name: '@deepseek-ai/dsh-command-compact'")
    expect(read('web-app/presets/minimal.patch.yml')).toContain("name: '@deepseek-ai/dsh-command-compact'")
  })
})
