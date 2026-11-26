/**
 * `Store` over Postgres (`pg`). Run `migrate` before opening.
 *
 * Every query binds values as parameters. Table and column names come from
 * the fixed tables below, never from callers. Owned collections keep the wire
 * record in `body` and copy indexed fields (environment `provider`, `status`,
 * `workspace_path`) out of it in the same statement. Their `created_at`
 * column is the insertion time and orders `list`.
 */

import { skillCollection } from './postgres-skills.ts'
import pg from 'pg'
import type { OwnerId } from '../auth/authenticator.ts'
import type { EnvironmentRecord, EnvironmentTemplate } from '../environment-types.ts'
import type { ListQuery } from '../http.ts'
import type { OAIAgent, OAIListResponse, SessionConfig } from '../types.ts'
import {
  RESUMABLE_STATUSES,
  type FileAttachmentSnapshot,
  type FileCollection,
  type FileRow,
  decodeSessionCursor,
  encodeSessionCursor,
  type OwnedCollection,
  type SessionIndexPatch,
  type SessionIndexRow,
  type SessionListQuery,
  type Store,
} from './store.ts'

/** Owned-collection table plus the columns copied out of `body`. */
interface OwnedTable<T> {
  table: 'agents' | 'environment_templates' | 'environments'
  columns: readonly string[]
  values: (value: T) => unknown[]
}

/**
 * @param table - table without copied columns.
 * @returns its spec.
 */
function plainTable<T>(table: 'agents' | 'environment_templates'): OwnedTable<T> {
  return { table, columns: [], values: () => [] }
}

const ENVIRONMENTS: OwnedTable<EnvironmentRecord> = {
  table: 'environments',
  columns: ['provider', 'status', 'workspace_path'],
  values: env => [env.provider, env.status, env.provider_metadata.workspace_directory ?? null],
}

/** `SessionIndexPatch` keys and their columns. */
const SESSION_PATCH_COLUMNS = {
  agentId: 'agent_id',
  environmentId: 'environment_id',
  dshSessionId: 'dsh_session_id',
  status: 'status',
  lastError: 'last_error',
  model: 'model',
  reasoningEffort: 'reasoning_effort',
  body: 'body',
} as const satisfies Record<Exclude<keyof SessionIndexPatch, 'updatedAt'>, string>

const SESSION_COLUMNS = 'id, owner_id, agent_id, environment_id, dsh_session_id, status, last_error, model, reasoning_effort, body, created_at, updated_at'

interface SessionDbRow {
  id: string
  owner_id: string
  agent_id: string | null
  environment_id: string | null
  dsh_session_id: string
  status: SessionIndexRow['status']
  last_error: string | null
  model: string
  reasoning_effort: string | null
  body: SessionConfig | Record<string, never>
  created_at: Date
  updated_at: Date
}

/**
 * @param row - `sessions` row.
 * @returns the index row.
 */
function sessionFromDb(row: SessionDbRow): SessionIndexRow {
  return {
    id: row.id,
    ownerId: row.owner_id as OwnerId,
    agentId: row.agent_id,
    environmentId: row.environment_id,
    dshSessionId: row.dsh_session_id,
    status: row.status,
    lastError: row.last_error,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    body: Object.keys(row.body).length === 0 ? null : row.body as SessionConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const FILE_COLUMNS = 'id, owner_id, name, media_type, bytes, sha256, status, session_id, attachment, workspace_path, created_at, attached_at'

interface FileDbRow {
  id: string
  owner_id: string
  name: string
  media_type: string
  /** `bigint` arrives as text from `pg`. */
  bytes: string
  sha256: string
  status: FileRow['status']
  session_id: string | null
  attachment: FileAttachmentSnapshot | null
  workspace_path: string | null
  created_at: Date
  attached_at: Date | null
}

/**
 * @param row - `files` row.
 * @returns the file record.
 */
function fileFromDb(row: FileDbRow): FileRow {
  return {
    id: row.id,
    ownerId: row.owner_id as OwnerId,
    name: row.name,
    mediaType: row.media_type,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    status: row.status,
    sessionId: row.session_id,
    attachment: row.attachment,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    attachedAt: row.attached_at,
  }
}

/**
 * @param pool - connection pool.
 * @returns the file collection over the `files` table.
 */
function fileCollection(pool: pg.Pool): FileCollection {
  return {
    async insert(row) {
      await pool.query(
        `insert into files (${FILE_COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [row.id, row.ownerId, row.name, row.mediaType, row.bytes, row.sha256, row.status, row.sessionId, row.attachment === null ? null : JSON.stringify(row.attachment), row.workspacePath, row.createdAt, row.attachedAt],
      )
    },
    async get(id, owner) {
      const result = await pool.query<FileDbRow>(`select ${FILE_COLUMNS} from files where id = $1 and owner_id = $2`, [id, owner])
      return result.rows[0] === undefined ? undefined : fileFromDb(result.rows[0])
    },
    async getMany(owner, ids) {
      if (ids.length === 0) return []
      const result = await pool.query<FileDbRow>(`select ${FILE_COLUMNS} from files where owner_id = $1 and id = any($2::text[])`, [owner, ids])
      return result.rows.map(fileFromDb)
    },
    async deleteStaged(id, owner) {
      const removed = await pool.query<FileDbRow>(`delete from files where id = $1 and owner_id = $2 and status = 'staged' returning ${FILE_COLUMNS}`, [id, owner])
      if (removed.rows[0] !== undefined) return fileFromDb(removed.rows[0])
      const existing = await pool.query('select 1 from files where id = $1 and owner_id = $2', [id, owner])
      return (existing.rowCount ?? 0) > 0 ? 'attached' : undefined
    },
    async stagedBytes(owner) {
      const result = await pool.query<{ total: string }>("select coalesce(sum(bytes), 0)::text as total from files where owner_id = $1 and status = 'staged'", [owner])
      return Number(result.rows[0]!.total)
    },
    async claim(owner, ids, sessionId) {
      if (new Set(ids).size !== ids.length) return undefined
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await client.query<FileDbRow>(
          `update files set status = 'attached', session_id = $3, attached_at = clock_timestamp()
           where owner_id = $1 and id = any($2::text[]) and status = 'staged'
           returning ${FILE_COLUMNS}`,
          [owner, ids, sessionId],
        )
        if (result.rows.length !== ids.length) {
          await client.query('rollback')
          return undefined
        }
        await client.query('commit')
        const byId = new Map(result.rows.map(row => [row.id, fileFromDb(row)]))
        return ids.map(id => byId.get(id)!)
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    async markAttached(id, owner, patch) {
      await pool.query(
        "update files set attachment = $3, attachment_id = $4, workspace_path = $5 where id = $1 and owner_id = $2 and status = 'attached'",
        [id, owner, JSON.stringify(patch.attachment), patch.attachment.ref.attachmentId, patch.workspacePath],
      )
    },
    async release(owner, ids) {
      if (ids.length === 0) return
      await pool.query(
        `update files set status = 'staged', session_id = null, attachment = null, attachment_id = null, workspace_path = null, attached_at = null
         where owner_id = $1 and id = any($2::text[]) and status = 'attached'`,
        [owner, ids],
      )
    },
    async list(owner, q) {
      const result = await pool.query<FileDbRow>(
        `with after_row as (select created_at, id from files where owner_id = $1 and id = $2)
         select ${FILE_COLUMNS} from files
         where owner_id = $1
           and ($4::text is null or status = $4)
           and (not exists (select 1 from after_row) or (created_at, id) < (select created_at, id from after_row))
         order by created_at desc, id desc
         limit $3`,
        [owner, q.after ?? null, q.limit + 1, q.status ?? null],
      )
      return { data: result.rows.slice(0, q.limit).map(fileFromDb), hasMore: result.rows.length > q.limit }
    },
    async listForSession(owner, sessionId) {
      const result = await pool.query<FileDbRow>(
        `select ${FILE_COLUMNS} from files where owner_id = $1 and session_id = $2 and status = 'attached' and attachment_id is not null order by attached_at, id`,
        [owner, sessionId],
      )
      return result.rows.map(fileFromDb)
    },
    async deleteForSession(owner, sessionId) {
      const result = await pool.query('delete from files where owner_id = $1 and session_id = $2', [owner, sessionId])
      return result.rowCount ?? 0
    },
    async expireStaged(before) {
      const result = await pool.query<FileDbRow>(`delete from files where status = 'staged' and created_at < $1 returning ${FILE_COLUMNS}`, [before])
      return result.rows.map(fileFromDb)
    },
    async stagedIds(ids) {
      if (ids.length === 0) return new Set()
      const result = await pool.query<{ id: string }>("select id from files where status = 'staged' and id = any($1::text[])", [ids])
      return new Set(result.rows.map(row => row.id))
    },
  }
}

/**
 * Build one owner-scoped collection over `spec.table`.
 * @param pool - connection pool.
 * @param spec - table and copied columns.
 * @returns the collection.
 */
function ownedCollection<T extends { id: string }>(pool: pg.Pool, spec: OwnedTable<T>): OwnedCollection<T> {
  const { table, columns } = spec
  const extraNames = columns.map(column => `, ${column}`).join('')
  const extraParams = columns.map((_, index) => `, $${String(index + 4)}`).join('')
  const extraSets = columns.map((column, index) => `, ${column} = $${String(index + 4)}`).join('')
  const insertSql = `insert into ${table} (id, owner_id, body, created_at, updated_at${extraNames}) values ($1, $2, $3, clock_timestamp(), clock_timestamp()${extraParams}) returning body`
  const updateSql = `update ${table} set body = $3, updated_at = clock_timestamp()${extraSets} where id = $1 and owner_id = $2 returning body`
  const listSql = (order: 'asc' | 'desc') => {
    const compare = order === 'asc' ? '>' : '<'
    return `with after_row as (select created_at, id from ${table} where owner_id = $1 and id = $2)
      select body from ${table}
      where owner_id = $1
        and (not exists (select 1 from after_row) or (created_at, id) ${compare} (select created_at, id from after_row))
      order by created_at ${order}, id ${order}
      limit $3`
  }
  const listAsc = listSql('asc')
  const listDesc = listSql('desc')
  return {
    async create(owner, value) {
      const result = await pool.query<{ body: T }>(insertSql, [value.id, owner, JSON.stringify(value), ...spec.values(value)])
      return result.rows[0]!.body
    },
    async get(owner, id) {
      const result = await pool.query<{ body: T }>(`select body from ${table} where id = $1 and owner_id = $2`, [id, owner])
      return result.rows[0]?.body
    },
    async update(owner, id, value) {
      const result = await pool.query<{ body: T }>(updateSql, [id, owner, JSON.stringify(value), ...spec.values(value)])
      return result.rows[0]?.body
    },
    async delete(owner, id) {
      const result = await pool.query(`delete from ${table} where id = $1 and owner_id = $2`, [id, owner])
      return (result.rowCount ?? 0) > 0
    },
    async list(owner: OwnerId, q: ListQuery): Promise<OAIListResponse<T>> {
      const sql = q.order === 'asc' ? listAsc : listDesc
      const result = await pool.query<{ body: T }>(sql, [owner, q.after ?? null, q.limit + 1])
      const data = result.rows.slice(0, q.limit).map(row => row.body)
      return {
        object: 'list',
        data,
        first_id: data[0]?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
        has_more: result.rows.length > q.limit,
      }
    },
  }
}

/**
 * Open a pooled `Store`. Run `migrate(url)` first.
 * @param url - Postgres connection URL.
 * @param onIdleClientError - receives errors of idle pooled connections; the pool discards such a connection either way.
 * @returns the store after one round trip has succeeded.
 * @throws when Postgres is unreachable; the pool is closed first.
 */
export async function openPostgresStore(url: string, onIdleClientError?: (error: Error) => void): Promise<Store> {
  const pool = new pg.Pool({ connectionString: url })
  // An idle connection that the server drops emits `error` on the pool; without a listener Node treats it as fatal.
  pool.on('error', (error) => {
    onIdleClientError?.(error)
  })
  try {
    await pool.query('select 1')
  } catch (error: unknown) {
    await pool.end()
    throw error
  }
  let closing: Promise<void> | undefined
  return {
    async ensureOwner(owner) {
      await pool.query('insert into owners (id) values ($1) on conflict (id) do nothing', [owner])
    },
    agents: ownedCollection(pool, plainTable<OAIAgent>('agents')),
    templates: ownedCollection(pool, plainTable<EnvironmentTemplate>('environment_templates')),
    environments: ownedCollection(pool, ENVIRONMENTS),
    files: fileCollection(pool),
    skills: skillCollection(pool),
    sessions: {
      async insert(row) {
        await pool.query(
          `insert into sessions (${SESSION_COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [row.id, row.ownerId, row.agentId, row.environmentId, row.dshSessionId, row.status, row.lastError, row.model, row.reasoningEffort, row.body === null ? {} : row.body, row.createdAt, row.updatedAt],
        )
      },
      async update(id, owner, patch) {
        const values: unknown[] = [id, owner === 'any' ? null : owner]
        const sets: string[] = []
        for (const [key, column] of Object.entries(SESSION_PATCH_COLUMNS) as Array<[keyof typeof SESSION_PATCH_COLUMNS, string]>) {
          if (patch[key] === undefined) continue
          values.push(patch[key])
          sets.push(`${column} = $${String(values.length)}`)
        }
        if (patch.updatedAt === undefined) {
          sets.push('updated_at = clock_timestamp()')
        } else {
          values.push(patch.updatedAt)
          sets.push(`updated_at = $${String(values.length)}`)
        }
        const result = await pool.query<SessionDbRow>(
          `update sessions set ${sets.join(', ')} where id = $1 and ($2::text is null or owner_id = $2) returning ${SESSION_COLUMNS}`,
          values,
        )
        const row = result.rows[0]
        return row === undefined ? undefined : sessionFromDb(row)
      },
      async mergeMetadata(id, owner, patch) {
        // One statement: the merge happens on the stored value, not on a copy the caller read earlier. Metadata values are strings, so stripping nulls only removes deleted keys.
        const result = await pool.query<SessionDbRow>(
          `update sessions set
             body = jsonb_set(body, '{metadata}', jsonb_strip_nulls(coalesce(body->'metadata', '{}'::jsonb) || $3::jsonb)),
             updated_at = clock_timestamp()
           where id = $1 and ($2::text is null or owner_id = $2) and body <> '{}'::jsonb
           returning ${SESSION_COLUMNS}`,
          [id, owner === 'any' ? null : owner, JSON.stringify(patch)],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : sessionFromDb(row)
      },
      async get(id, owner) {
        const result = await pool.query<SessionDbRow>(
          `select ${SESSION_COLUMNS} from sessions where id = $1 and ($2::text is null or owner_id = $2)`,
          [id, owner === 'any' ? null : owner],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : sessionFromDb(row)
      },
      async delete(id, owner) {
        const result = await pool.query(
          'delete from sessions where id = $1 and ($2::text is null or owner_id = $2)',
          [id, owner === 'any' ? null : owner],
        )
        return (result.rowCount ?? 0) > 0
      },
      async list(q: SessionListQuery) {
        const after = q.cursor === undefined ? undefined : decodeSessionCursor(q.cursor)
        const result = await pool.query<SessionDbRow>(
          `select ${SESSION_COLUMNS} from sessions
           where ($1::text is null or owner_id = $1)
             and ($2::text is null or agent_id = $2)
             and ($3::text is null or status = $3)
             and ($4::timestamptz is null or created_at >= $4)
             and ($5::timestamptz is null or created_at < $5)
             and ($6::timestamptz is null or (created_at, id) < ($6, $7::text))
             and ($9::jsonb is null or body->'metadata' @> $9::jsonb)
           order by created_at desc, id desc
           limit $8`,
          [
            q.owner === 'any' ? null : q.owner,
            q.agentId ?? null,
            q.status ?? null,
            q.from ?? null,
            q.to ?? null,
            after?.createdAt ?? null,
            after?.id ?? null,
            q.limit + 1,
            q.metadata === undefined || Object.keys(q.metadata).length === 0 ? null : JSON.stringify(q.metadata),
          ],
        )
        const data = result.rows.slice(0, q.limit).map(sessionFromDb)
        const last = data.at(-1)
        return {
          data,
          nextCursor: result.rows.length > q.limit && last !== undefined ? encodeSessionCursor(last.createdAt, last.id) : null,
        }
      },
      async listResumable() {
        const result = await pool.query<SessionDbRow>(
          `select ${SESSION_COLUMNS} from sessions where status = any($1::text[]) order by created_at asc, id asc`,
          [RESUMABLE_STATUSES],
        )
        return result.rows.map(sessionFromDb)
      },
      async ownersOf(ids) {
        const owners = new Map<string, OwnerId>()
        if (ids.length === 0) return owners
        const result = await pool.query<{ id: string; owner_id: string }>(
          'select id, owner_id from sessions where id = any($1::text[])',
          [ids],
        )
        for (const row of result.rows) owners.set(row.id, row.owner_id as OwnerId)
        return owners
      },
    },
    async audit(entry) {
      await pool.query(
        'insert into admin_audit (actor, action, target, at) values ($1, $2, $3, now())',
        [entry.actor, entry.action, entry.target],
      )
    },
    close() {
      closing ??= pool.end()
      return closing
    },
  }
}
