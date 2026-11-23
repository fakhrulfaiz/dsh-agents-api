/**
 * Installing skills, shared by the HTTP routes and the chat tools:
 * stage (validate, index, write), review, activate, edit, delete, expire.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OwnerId } from '../auth/authenticator.ts'
import type { SkillOrigin, SkillRow, SkillScope, SkillSource, Store } from '../store/store.ts'
import { removeSkill, skillDir, writeSkill } from './disk.ts'
import { packageFromEditor, packageFromFiles, skillBody, SkillInvalidError, type SkillPackage } from './package.ts'
import { readdir, stat } from 'node:fs/promises'

/** What installing needs. */
export interface InstallDeps {
  store: Store
  /** Installed-skills folder (`skills.dir`). */
  root: string
  /** Built-in names an installed skill may not take. */
  reserved: () => ReadonlySet<string>
  /** Refresh every live session of the owner. */
  invalidate: (owner: OwnerId) => void
}

/** Where a new skill goes. */
export interface InstallTarget {
  scope: SkillScope
  /** Saved agent id, for `scope: 'agent'`. */
  agentId?: string
}

/** The install target names an agent the caller does not have. */
export class SkillTargetNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" not found`)
    this.name = 'SkillTargetNotFoundError'
  }
}

/** An installed skill on the wire: the row without its owner, plus the agents that use it. */
export type WireInstalledSkill = Omit<SkillRow, 'owner'> & { object: 'agent.skill'; used_by: string[] }

const now = (): number => Math.floor(Date.now() / 1000)

/**
 * @param value - request target fields.
 * @returns the target, or a message for a bad one.
 */
export function parseTarget(value: { scope?: unknown; agent_id?: unknown }): InstallTarget | string {
  const scope = value.scope ?? 'library'
  if (scope !== 'library' && scope !== 'agent') return 'scope must be "library" or "agent"'
  if (scope === 'library') return { scope }
  if (typeof value.agent_id !== 'string' || value.agent_id === '') return 'agent_id is required for scope "agent"'
  return { scope, agentId: value.agent_id }
}

/**
 * Index then write a skill. The row is inserted first so a duplicate name
 * never touches another skill's folder; a failed write removes the row.
 * @returns the new row.
 * @throws SkillNameTakenError, SkillTargetNotFoundError, or a write error.
 */
export async function stageSkill(
  deps: InstallDeps,
  owner: OwnerId,
  pkg: SkillPackage,
  target: InstallTarget,
  source: SkillSource,
  origin: SkillOrigin | null = null,
  status: SkillRow['status'] = 'pending_review',
): Promise<SkillRow> {
  if (target.scope === 'agent' && (target.agentId === undefined || await deps.store.agents.get(owner, target.agentId) === undefined)) {
    throw new SkillTargetNotFoundError(target.agentId ?? '')
  }
  const at = now()
  const row: SkillRow = {
    id: `skill_${randomUUID().replaceAll('-', '')}`,
    owner,
    scope: target.scope,
    agent_id: target.scope === 'agent' ? target.agentId ?? null : null,
    name: pkg.name,
    description: pkg.description,
    source,
    origin,
    content_hash: pkg.contentHash,
    has_scripts: pkg.hasScripts,
    status,
    created_at: at,
    updated_at: at,
  }
  await deps.store.skills.insert(row)
  try {
    await writeSkill(skillDir(deps.root, row), pkg)
  } catch (error: unknown) {
    await deps.store.skills.delete(row.id, owner)
    throw error
  }
  if (status === 'active') deps.invalidate(owner)
  return row
}

/** @returns the activated row, or `undefined` when missing or foreign. */
export async function activateSkill(deps: InstallDeps, owner: OwnerId, id: string): Promise<SkillRow | undefined> {
  const row = await deps.store.skills.update(id, owner, { status: 'active', updated_at: now() })
  if (row !== undefined) deps.invalidate(owner)
  return row
}

/**
 * Replace the files of a skill with a new package (a GitHub update), keeping its id.
 * @returns the updated row.
 */
export async function replaceSkill(deps: InstallDeps, owner: OwnerId, row: SkillRow, pkg: SkillPackage, origin: SkillOrigin | null, status: SkillRow['status']): Promise<SkillRow | undefined> {
  if (pkg.name !== row.name) throw new SkillInvalidError(`the skill is now named "${pkg.name}"; delete "${row.name}" and install it again`)
  await writeSkill(skillDir(deps.root, row), pkg)
  const updated = await deps.store.skills.update(row.id, owner, { description: pkg.description, content_hash: pkg.contentHash, has_scripts: pkg.hasScripts, origin, status, updated_at: now() })
  deps.invalidate(owner)
  return updated
}

/**
 * Edit an editor or chat skill's description and body.
 * @returns the updated row, or `undefined` when missing or foreign.
 * @throws SkillInvalidError for a skill that came from an upload or GitHub.
 */
export async function editSkill(deps: InstallDeps, owner: OwnerId, id: string, input: { description?: string; body?: string }): Promise<SkillRow | undefined> {
  const row = await deps.store.skills.get(id, owner)
  if (row === undefined) return undefined
  if (row.source !== 'editor' && row.source !== 'chat') throw new SkillInvalidError('only skills written in Agentry can be edited; re-upload or update this one')
  const text = await readFile(join(skillDir(deps.root, row), 'SKILL.md'), 'utf8').catch(() => '')
  const pkg = packageFromEditor({ name: row.name, description: input.description ?? row.description, body: input.body ?? skillBody(text) }, deps.reserved())
  return replaceSkill(deps, owner, row, pkg, null, row.status)
}

/** @returns whether a skill was removed. */
export async function deleteSkill(deps: InstallDeps, owner: OwnerId, id: string): Promise<boolean> {
  const row = await deps.store.skills.delete(id, owner)
  if (row === undefined) return false
  await removeSkill(skillDir(deps.root, row))
  deps.invalidate(owner)
  return true
}

/** Seconds a staged skill waits for review. */
export const STAGED_TTL_SECONDS = 24 * 3600

/**
 * Delete skills that stayed in review for more than a day, with their folders.
 * @param at - current time, epoch seconds.
 * @returns how many were removed.
 */
export async function sweepStaged(deps: InstallDeps, at: number): Promise<number> {
  const removed = await deps.store.skills.deleteStagedBefore(at - STAGED_TTL_SECONDS)
  for (const row of removed) await removeSkill(skillDir(deps.root, row))
  return removed.length
}

/**
 * @param row - installed skill.
 * @param usedBy - ids of the owner's agents that use it.
 * @returns the wire object.
 */
export function toWireInstalled(row: SkillRow, usedBy: string[]): WireInstalledSkill {
  const { owner: _owner, ...rest } = row
  return { object: 'agent.skill', ...rest, used_by: usedBy }
}

/**
 * @returns ids of the owner's saved agents that use `row`: the private skill's agent, or agents whose selection lists it.
 */
export async function usedBy(store: Store, owner: OwnerId, row: SkillRow): Promise<string[]> {
  if (row.scope === 'agent') return row.agent_id === null ? [] : [row.agent_id]
  const agents = await store.agents.list(owner, { limit: 100 })
  return agents.data.filter(a => a.skills?.library.includes(row.id) === true).map(a => a.id)
}

/**
 * The review manifest: the skill, its files with sizes, and its `SKILL.md`.
 */
export async function skillManifest(deps: InstallDeps, row: SkillRow): Promise<{ skill: WireInstalledSkill; files: { path: string; bytes: number }[]; skill_md: string }> {
  const dir = skillDir(deps.root, row)
  const files: { path: string; bytes: number }[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push({ path, bytes: (await stat(join(dir, path))).size })
    }
  }
  await walk('')
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  return { skill: toWireInstalled(row, await usedBy(deps.store, row.owner, row)), files, skill_md: await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => '') }
}

/** Re-exported so callers validate file lists the same way. */
export { packageFromFiles }
