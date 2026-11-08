/**
 * Forward-only Postgres migrations.
 *
 * Files named `NNNN-<slug>.sql` in `migrations/` apply in name order, once
 * each, inside one transaction that holds a transaction-scoped advisory lock,
 * so concurrent starts serialize and a failed file leaves no partial schema.
 * Applied files are recorded in `schema_migrations`. A file is never edited
 * after release; a schema change adds the next number.
 */

import { readdir, readFile } from 'node:fs/promises'
import pg from 'pg'

/**
 * Directory of migration files. The build copies `src/store/migrations` to
 * `lib/migrations`, which sits beside the bundled `lib/index.js` the same way
 * this directory sits beside `src/store/migrate.ts`.
 */
const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url)

const MIGRATION_FILE = /^\d{4}-[a-z0-9-]+\.sql$/u

/** A migration could not be read or applied. Every file of the failed run is rolled back. */
export class MigrationError extends Error {
  /**
   * @param message - what failed, naming the file when one was being applied.
   * @param cause - underlying database or filesystem error.
   */
  constructor(message: string, cause: unknown) {
    super(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'MigrationError'
  }
}

/**
 * Read migration files in apply order.
 * @returns file names and SQL text.
 */
async function migrationFiles(): Promise<Array<{ name: string; sql: string }>> {
  const names = (await readdir(MIGRATIONS_DIR)).filter(name => MIGRATION_FILE.test(name)).sort()
  return Promise.all(names.map(async name => ({ name, sql: await readFile(new URL(name, MIGRATIONS_DIR), 'utf8') })))
}

/**
 * Apply every migration file not yet recorded in `schema_migrations`.
 * @param url - Postgres connection URL.
 * @returns names of the files this call applied, in order; empty when the schema was current.
 * @throws MigrationError when connecting, reading, or applying fails.
 */
export async function migrate(url: string): Promise<{ applied: string[] }> {
  let files: Array<{ name: string; sql: string }>
  try {
    files = await migrationFiles()
  } catch (error: unknown) {
    throw new MigrationError('cannot read migration files', error)
  }
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
  } catch (error: unknown) {
    await client.end().catch(() => undefined)
    throw new MigrationError('cannot connect to Postgres', error)
  }
  let current = 'schema_migrations'
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtext('agentry-migrations'))")
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null)')
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map(row => row.name))
    const applied: string[] = []
    for (const file of files) {
      if (done.has(file.name)) continue
      current = file.name
      await client.query(file.sql)
      await client.query('insert into schema_migrations (name, applied_at) values ($1, now())', [file.name])
      applied.push(file.name)
    }
    await client.query('commit')
    return { applied }
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined)
    throw new MigrationError(`migration ${current} failed`, error)
  } finally {
    await client.end()
  }
}
