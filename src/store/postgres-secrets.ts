/**
 * The `owner_secrets` table behind `Store.secrets`. Values arrive sealed; this module never sees a plain secret.
 */

import type pg from 'pg'
import type { SecretCollection, SecretRow } from './store.ts'

interface SecretDbRow {
  sealed: string
  last4: string
  created_at: Date
  updated_at: Date
}

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000)

function fromDb(row: SecretDbRow): SecretRow {
  return { sealed: row.sealed, last4: row.last4, created_at: seconds(row.created_at), updated_at: seconds(row.updated_at) }
}

/**
 * @param pool - connection pool.
 * @returns the secret collection over the `owner_secrets` table.
 */
export function secretCollection(pool: pg.Pool): SecretCollection {
  return {
    async get(owner, name) {
      const result = await pool.query<SecretDbRow>('select sealed, last4, created_at, updated_at from owner_secrets where owner_id = $1 and name = $2', [owner, name])
      return result.rows[0] === undefined ? undefined : fromDb(result.rows[0])
    },
    async put(owner, name, value) {
      const result = await pool.query<SecretDbRow>(
        `insert into owner_secrets (owner_id, name, sealed, last4) values ($1, $2, $3, $4)
         on conflict (owner_id, name) do update set sealed = excluded.sealed, last4 = excluded.last4, updated_at = now()
         returning sealed, last4, created_at, updated_at`,
        [owner, name, value.sealed, value.last4],
      )
      return fromDb(result.rows[0]!)
    },
    async delete(owner, name) {
      const result = await pool.query('delete from owner_secrets where owner_id = $1 and name = $2', [owner, name])
      return (result.rowCount ?? 0) > 0
    },
  }
}
