/**
 * The `skills` table behind `Store.skills`.
 */

import type pg from 'pg'
import type { OwnerId } from '../auth/authenticator.ts'
import { SkillNameTakenError, type SkillCollection, type SkillRow } from './store.ts'

const COLUMNS = 'id, owner_id, scope, agent_id, name, description, source, origin, content_hash, has_scripts, status, created_at, updated_at'

interface SkillDbRow {
  id: string
  owner_id: string
  scope: SkillRow['scope']
  agent_id: string | null
  name: string
  description: string
  source: SkillRow['source']
  origin: SkillRow['origin']
  content_hash: string
  has_scripts: boolean
  status: SkillRow['status']
  created_at: Date
  updated_at: Date
}

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000)
const timestamp = (value: number): Date => new Date(value * 1000)

function fromDb(row: SkillDbRow): SkillRow {
  return {
    id: row.id,
    owner: row.owner_id as OwnerId,
    scope: row.scope,
    agent_id: row.agent_id,
    name: row.name,
    description: row.description,
    source: row.source,
    origin: row.origin,
    content_hash: row.content_hash,
    has_scripts: row.has_scripts,
    status: row.status,
    created_at: seconds(row.created_at),
    updated_at: seconds(row.updated_at),
  }
}

/** Patchable columns, in a fixed order. */
const PATCHABLE = ['description', 'content_hash', 'has_scripts', 'status', 'origin', 'updated_at'] as const

/**
 * @param pool - connection pool.
 * @returns the skill collection over the `skills` table.
 */
export function skillCollection(pool: pg.Pool): SkillCollection {
  const one = (rows: SkillDbRow[]) => (rows[0] === undefined ? undefined : fromDb(rows[0]))
  return {
    async insert(row) {
      try {
        await pool.query(
          `insert into skills (${COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [row.id, row.owner, row.scope, row.agent_id, row.name, row.description, row.source, row.origin === null ? null : JSON.stringify(row.origin),
            row.content_hash, row.has_scripts, row.status, timestamp(row.created_at), timestamp(row.updated_at)],
        )
      } catch (error: unknown) {
        const { code, constraint } = error as { code?: string; constraint?: string }
        if (code === '23505' && constraint !== 'skills_pkey') throw new SkillNameTakenError(row.name)
        throw error
      }
    },
    async get(id, owner) {
      return one((await pool.query<SkillDbRow>(`select ${COLUMNS} from skills where id = $1 and owner_id = $2`, [id, owner])).rows)
    },
    async list(owner, filter = {}) {
      const where = ['owner_id = $1']
      const values: unknown[] = [owner]
      if (filter.scope !== undefined) where.push(`scope = $${String(values.push(filter.scope))}`)
      if (filter.agentId !== undefined) where.push(`agent_id = $${String(values.push(filter.agentId))}`)
      if (filter.status !== undefined) where.push(`status = $${String(values.push(filter.status))}`)
      const result = await pool.query<SkillDbRow>(`select ${COLUMNS} from skills where ${where.join(' and ')} order by created_at, id`, values)
      return result.rows.map(fromDb)
    },
    async update(id, owner, patch) {
      const sets: string[] = []
      const values: unknown[] = [id, owner]
      for (const key of PATCHABLE) {
        if (!(key in patch)) continue
        const value = patch[key]
        const param = key === 'updated_at' ? timestamp(value as number) : key === 'origin' ? (value === null ? null : JSON.stringify(value)) : value
        sets.push(`${key} = $${String(values.push(param))}`)
      }
      if (sets.length === 0) return this.get(id, owner)
      return one((await pool.query<SkillDbRow>(`update skills set ${sets.join(', ')} where id = $1 and owner_id = $2 returning ${COLUMNS}`, values)).rows)
    },
    async delete(id, owner) {
      return one((await pool.query<SkillDbRow>(`delete from skills where id = $1 and owner_id = $2 returning ${COLUMNS}`, [id, owner])).rows)
    },
    async deleteStagedBefore(cutoff) {
      const result = await pool.query<SkillDbRow>(`delete from skills where status = 'pending_review' and updated_at < $1 returning ${COLUMNS}`, [timestamp(cutoff)])
      return result.rows.map(fromDb)
    },
  }
}
