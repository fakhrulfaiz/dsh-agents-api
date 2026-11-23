/**
 * Which skills an agent uses: Agentry built-ins plus the owner's installed
 * skills, per the agent's `skills` selection (spec §2).
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { OwnerId } from '../auth/authenticator.ts'
import type { SkillRow, Store } from '../store/store.ts'
import type { AgentSkillSelection, OAIAgent } from '../types.ts'

/** A skill shipped in Agentry's own `skills/` folder. */
export interface BuiltinSkill {
  name: string
  description: string
  /** Folder holding its `SKILL.md`. */
  dir: string
}

/** One agent's effective skills. */
export interface ResolvedSkills {
  builtins: BuiltinSkill[]
  /** Active library and private rows. */
  installed: SkillRow[]
}

/** Installed skill id grammar. */
export const SKILL_ID = /^skill_[a-f0-9]{32}$/u

/**
 * Read the built-in skills under `root`: one folder per skill with a `SKILL.md`
 * whose frontmatter names it. Folders without valid frontmatter are skipped.
 * @param root - built-in skills folder.
 * @returns the built-ins, sorted by name.
 */
export async function loadBuiltins(root: string): Promise<BuiltinSkill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found: BuiltinSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined)
    const head = text === undefined ? undefined : /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1]
    if (head === undefined) continue
    let data: Record<string, unknown>
    try {
      data = (parse(head) ?? {}) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof data.name !== 'string' || typeof data.description !== 'string') continue
    found.push({ name: data.name, description: data.description, dir })
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * @param input - the agent (`undefined` for the default chat), its owner, the store, and the built-ins.
 * @returns the built-ins and active installed rows the agent uses. Unknown names and ids in a selection are ignored.
 */
export async function resolveAgentSkills(input: {
  agent: Pick<OAIAgent, 'id' | 'skills'> | undefined
  owner: OwnerId
  store: Store
  builtins: readonly BuiltinSkill[]
}): Promise<ResolvedSkills> {
  const { agent, owner, store } = input
  const rows = await store.skills.list(owner, { status: 'active' })
  const library = rows.filter(r => r.scope === 'library')
  const own = agent === undefined ? [] : rows.filter(r => r.scope === 'agent' && r.agent_id === agent.id)
  const selection = agent?.skills ?? null
  if (agent === undefined) return { builtins: [...input.builtins], installed: library }
  if (selection === null) return { builtins: [...input.builtins], installed: own }
  const builtinNames = new Set(selection.builtin)
  const libraryIds = new Set(selection.library)
  return {
    builtins: input.builtins.filter(b => builtinNames.has(b.name)),
    installed: [...library.filter(r => libraryIds.has(r.id)), ...own],
  }
}

/**
 * @param value - an agent's `skills` field from a request.
 * @param builtinNames - known built-in names.
 * @returns an error message, or `undefined` when valid.
 */
export function validateSkillSelection(value: unknown, builtinNames: ReadonlySet<string>): string | undefined {
  if (value === undefined || value === null) return undefined
  const selection = value as Partial<AgentSkillSelection>
  if (typeof value !== 'object' || !Array.isArray(selection.builtin) || !Array.isArray(selection.library)) {
    return 'skills must be null or an object with "builtin" and "library" string arrays'
  }
  for (const name of selection.builtin) {
    if (typeof name !== 'string' || !builtinNames.has(name)) return `skills.builtin: "${String(name)}" is not a built-in skill`
  }
  for (const id of selection.library) {
    if (typeof id !== 'string' || !SKILL_ID.test(id)) return `skills.library: "${String(id)}" is not a skill id`
  }
  return undefined
}
