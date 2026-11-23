/** The agent-scoped `agentry` skill provider. */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownerId } from '../src/auth/authenticator.ts'
import { createAgentrySkillProvider, SkillInvalidations } from '../src/skills/provider.ts'
import type { ResolvedSkills } from '../src/skills/resolve.ts'
import type { SkillRow } from '../src/store/store.ts'

const OWNER = ownerId('dev')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'provider-'))
  const builtinDir = join(root, 'builtins', 'create-agent')
  await mkdir(builtinDir, { recursive: true })
  await writeFile(join(builtinDir, 'SKILL.md'), '---\nname: create-agent\ndescription: Agents\n---\n\n# Create agent\n')
  const libDir = join(root, 'data', 'dev', 'library', 'haiku')
  await mkdir(libDir, { recursive: true })
  await writeFile(join(libDir, 'SKILL.md'), '---\nname: haiku\ndescription: Haiku\n---\n\nWrite haiku.\n')
  const lib: SkillRow = { id: `skill_${'1'.repeat(32)}`, owner: OWNER, scope: 'library', agent_id: null, name: 'haiku', description: 'Haiku', source: 'editor', origin: null, content_hash: 'h', has_scripts: false, status: 'active', created_at: 1, updated_at: 1 }
  return { root, builtinDir, libDir, lib }
}

function control() {
  let invalidations = 0
  return { ctl: { signal: new AbortController().signal, invalidate: () => { invalidations++ } }, count: () => invalidations }
}

describe('agentry skill provider', () => {
  it('lists one candidate per resolved skill', async () => {
    const f = await fixture()
    const resolved: ResolvedSkills = { builtins: [{ name: 'create-agent', description: 'Agents', dir: f.builtinDir }], installed: [f.lib] }
    const provider = createAgentrySkillProvider({ resolve: () => Promise.resolve(resolved), root: join(f.root, 'data') })(control().ctl)
    expect(provider.name).toBe('agentry')
    const candidates = await provider.list({}) as readonly { name: string; provider: string; source: string; path?: string }[]
    expect(candidates.map(c => [c.name, c.provider, c.source])).toEqual([['create-agent', 'agentry', 'agentry-builtin'], ['haiku', 'agentry', 'agentry-library']])
    expect(candidates[1]?.path).toBe(join(f.libDir, 'SKILL.md'))
  })

  it('get returns the body without frontmatter and a directory resource base', async () => {
    const f = await fixture()
    const provider = createAgentrySkillProvider({ resolve: () => Promise.resolve({ builtins: [], installed: [f.lib] }), root: join(f.root, 'data') })(control().ctl)
    const [candidate] = await provider.list({}) as never[]
    const skill = await provider.get(candidate!, {})
    expect(skill?.content).toBe('Write haiku.\n')
    expect(skill?.resourceBase).toEqual({ kind: 'directory', path: f.libDir })
  })

  it('a missing folder makes get answer undefined', async () => {
    const f = await fixture()
    const gone = { ...f.lib, name: 'gone' }
    const provider = createAgentrySkillProvider({ resolve: () => Promise.resolve({ builtins: [], installed: [gone] }), root: join(f.root, 'data') })(control().ctl)
    const [candidate] = await provider.list({}) as never[]
    expect(await provider.get(candidate!, {})).toBeUndefined()
  })

  it('invalidations reach every provider of an owner, and stop after dispose', () => {
    const registry = new SkillInvalidations()
    let a = 0
    let b = 0
    const disposeA = registry.add(OWNER, () => { a++ })
    registry.add(ownerId('other'), () => { b++ })
    registry.invalidate(OWNER)
    disposeA()
    registry.invalidate(OWNER)
    expect([a, b]).toEqual([1, 0])
  })
})
