/** The experimental Agents API package's declared profile patch. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import '../src/index.ts'

describe('dsh-agents-api bundle', () => {
  it('declares a webserver plus agents-api insert over base', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/schemastery': '^3.18.2',
    })
    const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: webserver')
    expect(patch).toContain("name: '@deepseek-ai/dsh-host-webserver'")
    expect(patch).toContain('id: agents-api')
    expect(patch).toContain("name: '@fakhrulfaiz/dsh-agents-api'")
    expect(patch).toContain("prefix: '/v1'")
  })
})
