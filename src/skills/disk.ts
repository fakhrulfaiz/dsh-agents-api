/**
 * Installed skill folders on disk: `<root>/<owner>/library/<name>` and
 * `<root>/<owner>/agents/<agentId>/<name>`. Writes go to a temporary sibling
 * and are renamed into place, so a reader never sees half a skill.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { directorySegment } from '../environment/local.ts'
import type { SkillRow } from '../store/store.ts'
import type { SkillPackage } from './package.ts'

/**
 * @param root - the plugin's `skills.dir`.
 * @param row - owner, scope, agent and name of the skill.
 * @returns the skill's folder.
 */
export function skillDir(root: string, row: Pick<SkillRow, 'owner' | 'scope' | 'agent_id' | 'name'>): string {
  const owner = directorySegment(row.owner, 'owner')
  return row.scope === 'agent'
    ? join(root, owner, 'agents', directorySegment(row.agent_id ?? '', 'agent'), row.name)
    : join(root, owner, 'library', row.name)
}

/**
 * Write a package to `dir`, replacing whatever was there.
 * @param dir - destination folder.
 * @param pkg - validated package (paths already checked).
 */
export async function writeSkill(dir: string, pkg: SkillPackage): Promise<void> {
  const staging = `${dir}.tmp-${randomBytes(6).toString('hex')}`
  try {
    for (const file of pkg.files) {
      const target = join(staging, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.bytes)
    }
    await mkdir(dirname(dir), { recursive: true })
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/**
 * @param dir - a skill folder from `skillDir`.
 */
export async function removeSkill(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
