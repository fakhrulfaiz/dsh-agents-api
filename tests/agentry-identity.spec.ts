/** Agentry identity: the profile patch's prompt rows and the Agentry preset. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const PERSONA = "You are Agentry, a general-purpose AI agent running on the {{model}} model. You help with research, writing, analysis, documents and spreadsheets, working in the user's connected apps, scheduling recurring tasks, creating and managing other agents, and software work: reading, writing and running code in your workspace. Pick the approach the task needs; do not assume every request is a coding task. When asked who or what you are, say you are Agentry."

interface Row { id?: string; name?: string; disabled?: unknown; config?: Record<string, unknown> & { plugins?: Row[] }; insert?: Row[]; group?: boolean }

/** `!!js` values become `{ js: source }` so they compare as their source text. */
const customTags = [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ js: source }) }]
const read = (path: string): Row[] => parse(readFileSync(path, 'utf8'), { customTags }) as Row[]
const root = fileURLToPath(new URL('..', import.meta.url))
const patch = read(resolve(root, 'cordis.patch.yml'))
/** Every row of the patch: id-targeted rows and inserted rows. */
const rows = patch.flatMap(row => (row.insert ? row.insert : [row]))
const row = (id: string) => rows.find(r => r.id === id)
const preset = () => row('preset-agentry')
const plugin = (plugins: Row[] | undefined, id: string) => plugins?.find(p => p.id === id)

/** Plugin rows in order, recursing through `cordis:group` children (their `config` is a row list). */
function flatten(plugins: Row[] | undefined): Row[] {
  return (plugins ?? []).flatMap(p => [p, ...(p.group === true && Array.isArray(p.config) ? flatten(p.config as Row[]) : [])])
}

describe('Agentry identity patch', () => {
  it('system-prompt drops the harness identity', () => {
    expect(row('system-prompt')?.config?.includeHarnessIdentity).toBe(false)
  })

  it('harness-dev-context is disabled', () => {
    expect(row('harness-dev-context')?.disabled).toBe(true)
  })

  it('agentry preset persona is the Agentry text', () => {
    const p = preset()
    expect(p?.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(p?.config?.id).toBe('agentry')
    const prefix = plugin(p?.config?.plugins, 'persona')?.config?.prefix
    expect(prefix).toBe(PERSONA)
    expect(prefix).not.toContain('coding agent')
    expect(prefix).not.toContain('DeepSeek Harness')
  })

  it('agentry preset hides developer skill roots', () => {
    expect(plugin(preset()?.config?.plugins, 'skill-filesystem')?.config?.includeDefaultRoots).toBe(false)
  })

  it('no skill-agentry row remains', () => {
    expect(row('skill-agentry')).toBeUndefined()
  })

  it.skipIf(process.env['DSH_ROOT'] === undefined)('agentry preset matches standard except persona and skill roots', () => {
    const standardFile = read(resolve(process.env['DSH_ROOT']!, 'packages/bundle/web-app/presets/standard.patch.yml'))
    const standard = standardFile.flatMap(r => r.insert ?? [r]).find(r => r.id === 'preset-standard')
    const ours = flatten(preset()?.config?.plugins)
    const theirs = flatten(standard?.config?.plugins)
    expect(theirs.length).toBeGreaterThan(10)
    expect(ours.map(p => p.id)).toEqual(theirs.map(p => p.id))
    for (const [index, mine] of ours.entries()) {
      if (mine.id === 'persona' || mine.id === 'skill-filesystem') continue
      expect(mine, `plugin ${mine.id ?? index}`).toEqual(theirs[index])
    }
  })
})
