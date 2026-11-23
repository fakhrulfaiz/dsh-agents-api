/**
 * The agent-scoped `agentry` skill provider: serves exactly one agent's
 * resolved skills (built-ins, library, private) into DSH's skill registry.
 * Registered on the agent's scope, so no other agent sees it.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { OwnerId } from '../auth/authenticator.ts'
import { skillDir } from './disk.ts'
import { skillBody } from './package.ts'
import type { ResolvedSkills } from './resolve.ts'

export const AGENTRY_SKILL_PROVIDER = 'agentry'

/** Discovery sources the provider reports, one per kind. */
export const AGENTRY_SOURCES = { builtin: 'agentry-builtin', library: 'agentry-library', private: 'agentry-private' } as const

/** Rank of Agentry skills against other providers' duplicates (lower wins). */
const RANK = 50

/**
 * @param deps - `resolve` reads the agent's skills (called on every catalog read); `root` is the installed-skills folder.
 * @returns the factory `ctx.skills.registerProvider` takes.
 */
export function createAgentrySkillProvider(deps: { resolve: () => Promise<ResolvedSkills>; root: string }): (control: SkillProviderControl) => SkillProvider {
  return () => ({
    name: AGENTRY_SKILL_PROVIDER,
    async list() {
      const resolved = await deps.resolve()
      const candidate = (name: string, description: string, dir: string, source: string): SkillCandidate => ({
        name,
        description,
        path: join(dir, 'SKILL.md'),
        source,
        provider: AGENTRY_SKILL_PROVIDER,
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: 'directory', path: dir },
        rank: RANK,
        locator: dir,
      })
      return [
        ...resolved.builtins.map(b => candidate(b.name, b.description, b.dir, AGENTRY_SOURCES.builtin)),
        ...resolved.installed.map(r => candidate(r.name, r.description, skillDir(deps.root, r), r.scope === 'agent' ? AGENTRY_SOURCES.private : AGENTRY_SOURCES.library)),
      ]
    },
    async get(candidate): Promise<SkillDefinition | undefined> {
      const dir = candidate.locator as string
      const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined)
      if (text === undefined) return undefined
      return {
        name: candidate.name,
        description: candidate.description,
        path: join(dir, 'SKILL.md'),
        invocation: candidate.invocation,
        source: candidate.source,
        provider: AGENTRY_SKILL_PROVIDER,
        resourceBase: { kind: 'directory', path: dir },
        content: skillBody(text),
      }
    },
  })
}

/** Live providers' invalidate hooks, by owner, so an install or edit refreshes every open session of that owner. */
export class SkillInvalidations {
  readonly #byOwner = new Map<string, Set<() => void>>()

  /**
   * @param owner - session owner.
   * @param invalidate - the provider registration's `control.invalidate`.
   * @returns a dispose function that forgets the hook.
   */
  add(owner: OwnerId, invalidate: () => void): () => void {
    const set = this.#byOwner.get(owner) ?? new Set()
    this.#byOwner.set(owner, set)
    set.add(invalidate)
    return () => {
      set.delete(invalidate)
      if (set.size === 0) this.#byOwner.delete(owner)
    }
  }

  /** @param owner - owner whose installed skills or agents changed. */
  invalidate(owner: OwnerId): void {
    for (const hook of [...(this.#byOwner.get(owner) ?? [])]) hook()
  }
}
