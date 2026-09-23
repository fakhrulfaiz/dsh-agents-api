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
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/schemastery': 'workspace:^',
    })
    const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('- id: webserver')
    expect(patch).toContain('id: agents-api')
    expect(patch).toContain("name: '@deepseek-ai/dsh-experimental-agents-api'")
    expect(patch).toContain("prefix: '/v1'")
  })
})
