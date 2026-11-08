/**
 * One disposable Postgres 16 container per test file (Testcontainers; Docker must be running).
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'

/** A started container plus helpers that create databases inside it. */
export interface TestPostgres {
  /** Connection URL of the container's default database. */
  readonly url: string
  /**
   * Create an empty database in the container.
   * @param name - database name; letters, digits, and underscores only.
   * @returns its connection URL.
   */
  createDatabase(name: string): Promise<string>
  /** Stop and remove the container. */
  stop(): Promise<void>
}

/**
 * Start `postgres:16-alpine`.
 * @returns the started container.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = container.getConnectionUri()
  return {
    url,
    async createDatabase(name) {
      if (!/^[a-z0-9_]+$/u.test(name)) throw new Error(`invalid test database name: ${name}`)
      const admin = new pg.Client({ connectionString: url })
      await admin.connect()
      try {
        // Identifiers cannot be bound as parameters; `name` is checked above.
        await admin.query(`create database ${name}`)
      } finally {
        await admin.end()
      }
      const next = new URL(url)
      next.pathname = `/${name}`
      return next.toString()
    },
    async stop() {
      await container.stop()
    },
  }
}
