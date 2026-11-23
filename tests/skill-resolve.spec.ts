/** Per-agent skill resolution, built-in discovery, and selection validation. */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownerId } from '../src/auth/authenticator.ts'
import type { SkillRow } from '../src/store/store.ts'
import { loadBuiltins, resolveAgentSkills, validateSkillSelection, type BuiltinSkill } from '../src/skills/resolve.ts'
import { MemoryStore } from './support/memory-store.ts'

const OWNER = ownerId('dev')
const builtins: BuiltinSkill[] = [
  { name: 'create-agent', description: 'Agents', dir: '/b/create-agent' },
  { name: 'composio', description: 'Apps', dir: '/b/composio' },
]
const id = (n: number) => `skill_${String(n).padStart(32, '0')}`
function row(n: number, extra: Partial<SkillRow> = {}): SkillRow {
  return { id: id(n), owner: OWNER, scope: 'library', agent_id: null, name: `lib-${String(n)}`, description: 'd', source: 'upload', origin: null, content_hash: 'h', has_scripts: false, status: 'active', created_at: n, updated_at: n, ...extra }
}

async function storeWith(rows: SkillRow[]) {
  const store = new MemoryStore()
  await store.ensureOwner(OWNER)
  for (const r of rows) await store.skills.insert(r)
  return store
}

const names = (r: Awaited<ReturnType<typeof resolveAgentSkills>>) => ({ builtins: r.builtins.map(b => b.name), installed: r.installed.map(i => i.name) })

describe('resolveAgentSkills', () => {
  it('a saved agent without a selection gets every built-in and no library skills', async () => {
    const store = await storeWith([row(1)])
    expect(names(await resolveAgentSkills({ agent: { id: 'agent_a', skills: null }, owner: OWNER, store, builtins }))).toEqual({ builtins: ['create-agent', 'composio'], installed: [] })
  })

  it('the default chat gets built-ins plus active library skills, not pending ones', async () => {
    const store = await storeWith([row(1), row(2, { status: 'pending_review' })])
    expect(names(await resolveAgentSkills({ agent: undefined, owner: OWNER, store, builtins }))).toEqual({ builtins: ['create-agent', 'composio'], installed: ['lib-1'] })
  })

  it('an explicit selection gets exactly that set', async () => {
    const store = await storeWith([row(1), row(2)])
    const agent = { id: 'agent_a', skills: { builtin: ['create-agent'], library: [id(2)] } }
    expect(names(await resolveAgentSkills({ agent, owner: OWNER, store, builtins }))).toEqual({ builtins: ['create-agent'], installed: ['lib-2'] })
  })

  it('private skills apply only to their own agent', async () => {
    const store = await storeWith([row(3, { scope: 'agent', agent_id: 'agent_a', name: 'mine' }), row(4, { scope: 'agent', agent_id: 'agent_b', name: 'theirs' })])
    expect(names(await resolveAgentSkills({ agent: { id: 'agent_a', skills: null }, owner: OWNER, store, builtins })).installed).toEqual(['mine'])
    expect(names(await resolveAgentSkills({ agent: undefined, owner: OWNER, store, builtins })).installed).toEqual([])
  })

  it('ignores a selected library id that no longer exists', async () => {
    const store = await storeWith([row(1)])
    const agent = { id: 'agent_a', skills: { builtin: [], library: [id(1), id(9)] } }
    expect(names(await resolveAgentSkills({ agent, owner: OWNER, store, builtins })).installed).toEqual(['lib-1'])
  })
})

describe('validateSkillSelection', () => {
  const known = new Set(['create-agent', 'composio'])
  it('accepts null, absent and a valid selection', () => {
    expect(validateSkillSelection(undefined, known)).toBeUndefined()
    expect(validateSkillSelection(null, known)).toBeUndefined()
    expect(validateSkillSelection({ builtin: ['composio'], library: [id(1)] }, known)).toBeUndefined()
  })
  it('names an unknown built-in, a malformed id, or a bad shape', () => {
    expect(validateSkillSelection({ builtin: ['nope'], library: [] }, known)).toMatch(/nope/u)
    expect(validateSkillSelection({ builtin: [], library: ['skill_x'] }, known)).toMatch(/skill_x/u)
    expect(validateSkillSelection({ builtin: 'composio', library: [] }, known)).toMatch(/skills/u)
  })
})

describe('loadBuiltins', () => {
  it('reads each skill folder with a valid SKILL.md, sorted by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'builtins-'))
    for (const name of ['zeta', 'alpha']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody`)
    }
    await mkdir(join(root, 'broken'))
    await writeFile(join(root, 'broken', 'SKILL.md'), 'no frontmatter')
    const loaded = await loadBuiltins(root)
    expect(loaded.map(b => b.name)).toEqual(['alpha', 'zeta'])
    expect(loaded[0]).toEqual({ name: 'alpha', description: 'alpha skill', dir: join(root, 'alpha') })
  })

  it('finds the repository built-ins create-agent and composio', async () => {
    const loaded = await loadBuiltins(new URL('../skills/', import.meta.url).pathname)
    expect(loaded.map(b => b.name)).toEqual(expect.arrayContaining(['composio', 'create-agent']))
  })
})
