import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentryPresetRows, createSandboxPresets, sandboxPresetRows, SANDBOX_ISOLATED, type PresetRow } from '../src/sandbox/presets.ts'

const PATCH = join(import.meta.dirname, '..', 'cordis.patch.yml')

function fakeRegistry() {
  const registered = new Map<string, readonly PresetRow[]>()
  const calls: string[] = []
  return {
    registered, calls,
    async register(def: { id: string; plugins: readonly PresetRow[] }) {
      if (registered.has(def.id)) throw new Error(`Duplicate agent preset: ${def.id}`)
      calls.push(`register ${def.id}`)
      registered.set(def.id, def.plugins)
      return async () => { calls.push(`unregister ${def.id}`); registered.delete(def.id) }
    },
  }
}

const ids = (rows: readonly PresetRow[]): string[] => rows.flatMap((r) => [String(r['id']), ...(r['group'] === true ? ids(r['config'] as PresetRow[]) : [])])

describe('sandbox presets', () => {
  it('two sessions on one sandbox share one registration, released a grace period after both end', async () => {
    vi.useFakeTimers()
    try {
      const reg = fakeRegistry()
      const presets = createSandboxPresets({ presets: () => reg, rows: () => [{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' }], graceMs: 1000 })
      const a = await presets.acquire('o', 'sbx_1', '/w')
      const b = await presets.acquire('o', 'sbx_1', '/w')
      expect(a.presetId).toBe('agentry-sbx-sbx_1')
      expect(reg.calls).toEqual(['register agentry-sbx-sbx_1'])
      await a[Symbol.asyncDispose]()
      await vi.advanceTimersByTimeAsync(5000)
      expect(reg.registered.size).toBe(1)
      await b[Symbol.asyncDispose]()
      await vi.advanceTimersByTimeAsync(500)
      const c = await presets.acquire('o', 'sbx_1', '/w')
      await c[Symbol.asyncDispose]()
      expect(reg.calls).toEqual(['register agentry-sbx-sbx_1'])
      await vi.advanceTimersByTimeAsync(1500)
      expect(reg.calls).toEqual(['register agentry-sbx-sbx_1', 'unregister agentry-sbx-sbx_1'])
      expect(presets.registered()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('evict (environment deleted) unregisters at once, even with live sessions', async () => {
    const reg = fakeRegistry()
    const presets = createSandboxPresets({ presets: () => reg, rows: () => [] })
    const lease = await presets.acquire('o', 'sbx_2', '/w')
    await presets.evict('sbx_2')
    expect(reg.registered.size).toBe(0)
    await lease[Symbol.asyncDispose]()
    expect(reg.calls).toEqual(['register agentry-sbx-sbx_2', 'unregister agentry-sbx-sbx_2'])
    await presets.acquire('o', 'sbx_2', '/w')
    expect(reg.registered.size).toBe(1)
  })

  it('a broken first activation is unregistered and reported, and the next acquire registers again (review I1)', async () => {
    const reg = fakeRegistry()
    let broken: string | undefined = 'ssh: Agentry Sandbox is not reachable'
    const registry = { ...reg, register: reg.register, resolve: async (id: string) => ({ id, ...(broken === undefined ? {} : { broken }) }) }
    const presets = createSandboxPresets({ presets: () => registry, rows: () => [] })
    await expect(presets.acquire('o', 'sbx_4', '/w')).rejects.toThrow(/could not start.*not reachable/)
    expect(reg.registered.size).toBe(0)
    expect(presets.registered()).toEqual([])
    broken = undefined
    const lease = await presets.acquire('o', 'sbx_4', '/w')
    expect(lease.presetId).toBe('agentry-sbx-sbx_4')
    expect(reg.calls).toEqual(['register agentry-sbx-sbx_4', 'unregister agentry-sbx-sbx_4', 'register agentry-sbx-sbx_4'])
  })

  it('a failed prepare fails the acquire and leaves nothing registered', async () => {
    const reg = fakeRegistry()
    const presets = createSandboxPresets({ presets: () => reg, rows: () => [], prepare: async () => { throw new Error('copy failed') } })
    await expect(presets.acquire('o', 'sbx_3', '/w')).rejects.toThrow('copy failed')
    expect(reg.registered.size).toBe(0)
    expect(presets.registered()).toEqual([])
  })

  it('rows: exactly one isolated group holding the runtime and every execution consumer; no credentials', () => {
    const base = agentryPresetRows(PATCH)
    const rows = sandboxPresetRows(base, { owner: 'o', sandboxId: 'sbx_9', workspace: '/w/o/sandbox-env_9' })
    expect(rows).toHaveLength(1)
    const group = rows[0]!
    expect(group).toMatchObject({ name: 'cordis:group', group: true })
    expect(Object.keys(group['isolate'] as object).sort()).toEqual([...SANDBOX_ISOLATED].sort())
    const inside = ids(group['config'] as PresetRow[])
    for (const id of ['agentry-sbx-runtime', 'agentry-sbx-policy', 'agentry-sbx-working-directory', 'agentry-sbx-bash', 'tool-bash', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'present', 'tool-workflow', 'workflow-ptc', 'tool-subagent', 'tool-subagent-fork', 'persona']) expect(inside).toContain(id)
    const isolatedGroups = JSON.stringify(rows).match(/"subprocess":true/g) ?? []
    expect(isolatedGroups).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toMatch(/"key"|"url"/)
    const runtime = (group['config'] as PresetRow[]).find((r) => r['id'] === 'agentry-sbx-runtime')
    expect(runtime).toMatchObject({ name: '@agentry/api/sandbox-runtime', config: { owner: 'o', sandboxId: 'sbx_9', workspace: '/w/o/sandbox-env_9' } })
    const bash = ids(base).includes('tool-bash') ? (base.find((r) => r['id'] === 'tool-bash') as PresetRow) : undefined
    expect(bash?.['disabled']).toEqual({ __jsExpr: "process.platform === 'win32'" })
  })
})
