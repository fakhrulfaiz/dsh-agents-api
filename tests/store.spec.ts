/**
 * `Store` behavior, run against the in-memory fake and against Postgres
 * (Testcontainers) so the fake that backs the gateway tests cannot drift.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ownerId, type OwnerId } from '../src/auth/authenticator.ts'
import type { EnvironmentRecord, EnvironmentTemplate } from '../src/environment-types.ts'
import type { SessionConfig } from '../src/types.ts'
import { materializeAgent } from '../src/agent-records.ts'
import { migrate } from '../src/store/migrate.ts'
import { openPostgresStore } from '../src/store/postgres.ts'
import { guardStore, InvalidCursorError, StoreUnavailableError, type FileRow, type SessionIndexRow, type Store } from '../src/store/store.ts'
import { MemoryStore } from './support/memory-store.ts'
import { startPostgres, type TestPostgres } from './support/postgres.ts'

const A = ownerId('owner-a')
const B = ownerId('owner-b')

interface Harness {
  /** A store with no records. */
  fresh(): Promise<Store>
}

let postgres: TestPostgres | undefined
let shared: Store | undefined

beforeAll(async () => {
  postgres = await startPostgres()
  const url = await postgres.createDatabase('contract')
  await migrate(url)
  shared = await openPostgresStore(url)
}, 180_000)

afterAll(async () => {
  await shared?.close()
  await postgres?.stop()
})

const harnesses: Array<[string, Harness]> = [
  ['memory', { fresh: () => Promise.resolve(new MemoryStore()) }],
  ['postgres', {
    async fresh() {
      const client = new pg.Client({ connectionString: await contractUrl() })
      await client.connect()
      try {
        await client.query('truncate admin_audit, files, sessions, environments, environment_templates, agents, owners')
      } finally {
        await client.end()
      }
      return shared!
    },
  }],
]

async function contractUrl(): Promise<string> {
  const next = new URL(postgres!.url)
  next.pathname = '/contract'
  return next.toString()
}

function sessionRow(id: string, owner: OwnerId, overrides: Partial<SessionIndexRow> = {}): SessionIndexRow {
  const at = overrides.createdAt ?? new Date('2026-11-08T10:00:00.000Z')
  return {
    id,
    ownerId: owner,
    agentId: null,
    environmentId: null,
    dshSessionId: id,
    status: 'idle',
    lastError: null,
    model: 'deepseek-chat',
    reasoningEffort: null,
    body: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

function fileRow(id: string, owner: OwnerId, overrides: Partial<FileRow> = {}): FileRow {
  return {
    id,
    ownerId: owner,
    name: 'notes.txt',
    mediaType: 'text/plain',
    bytes: 100,
    sha256: 'a'.repeat(64),
    status: 'staged',
    sessionId: null,
    attachment: null,
    workspacePath: null,
    createdAt: new Date('2026-11-10T10:00:00.000Z'),
    attachedAt: null,
    ...overrides,
  }
}

function template(id: string, name: string): EnvironmentTemplate {
  return { id, object: 'environment.template', name, provider: 'local', config: { image: 'base' }, created_at: 1 }
}

function environment(id: string, status: EnvironmentRecord['status']): EnvironmentRecord {
  return {
    id,
    object: 'environment',
    status,
    provider: 'local',
    provider_metadata: { workspace_directory: `/w/${id}` },
    created_at: 1,
  }
}

describe.each(harnesses)('Store contract (%s)', (_name, harness) => {
  it('owner scoping: another owner cannot read, list, update, or delete a record', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    const agent = await store.agents.create(A, materializeAgent({ model: 'deepseek-chat', name: 'mine' }))
    expect(await store.agents.get(A, agent.id)).toEqual(agent)
    expect(await store.agents.get(B, agent.id)).toBeUndefined()
    expect((await store.agents.list(B, { limit: 20 })).data).toEqual([])
    expect(await store.agents.update(B, agent.id, { ...agent, name: 'stolen' })).toBeUndefined()
    expect(await store.agents.delete(B, agent.id)).toBe(false)
    expect((await store.agents.get(A, agent.id))?.name).toBe('mine')
    expect(await store.agents.delete(A, agent.id)).toBe(true)
    expect(await store.agents.get(A, agent.id)).toBeUndefined()
    expect(await store.agents.delete(A, agent.id)).toBe(false)
  })

  it('ensureOwner is idempotent and records need an existing owner', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(A)
    await expect(store.agents.create(ownerId('nobody'), materializeAgent({ model: 'm' }))).rejects.toThrow()
    await expect(store.sessions.insert(sessionRow('sess_x', ownerId('nobody')))).rejects.toThrow()
  })

  it('update replaces the stored record', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    const agent = await store.agents.create(A, materializeAgent({ model: 'deepseek-chat', name: 'a', metadata: { k: 'v' } }))
    const replaced = { ...agent, name: 'b', metadata: {}, updated_at: agent.updated_at + 5 }
    expect(await store.agents.update(A, agent.id, replaced)).toEqual(replaced)
    expect(await store.agents.get(A, agent.id)).toEqual(replaced)
    expect(await store.agents.update(A, 'missing', replaced)).toBeUndefined()
  })

  it('pages owned records newest first by insertion, with after and asc order', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    const ids: string[] = []
    for (const name of ['one', 'two', 'three']) {
      ids.push((await store.agents.create(A, materializeAgent({ model: 'deepseek-chat', name }))).id)
    }
    const [one, two, three] = ids as [string, string, string]
    const first = await store.agents.list(A, { limit: 2 })
    expect(first).toMatchObject({ object: 'list', first_id: three, last_id: two, has_more: true })
    expect(first.data.map(agent => agent.id)).toEqual([three, two])
    const second = await store.agents.list(A, { limit: 2, after: two })
    expect(second.data.map(agent => agent.id)).toEqual([one])
    expect(second.has_more).toBe(false)
    expect((await store.agents.list(A, { limit: 20, order: 'asc' })).data.map(agent => agent.id)).toEqual([one, two, three])
    expect((await store.agents.list(A, { limit: 20, order: 'asc', after: one })).data.map(agent => agent.id)).toEqual([two, three])
    expect((await store.agents.list(A, { limit: 20, after: 'agent_unknown' })).data.map(agent => agent.id)).toEqual([three, two, one])
    expect(await store.agents.list(A, { limit: 2, after: one })).toEqual({ object: 'list', data: [], first_id: null, last_id: null, has_more: false })
  })

  it('stores templates and environments per owner', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    await store.templates.create(A, template('tpl_1', 'base'))
    expect((await store.templates.get(A, 'tpl_1'))?.name).toBe('base')
    expect(await store.templates.get(B, 'tpl_1')).toBeUndefined()
    await store.environments.create(A, environment('env_1', 'pending'))
    const connected = { ...environment('env_1', 'connected'), updated_at: 2 }
    expect(await store.environments.update(A, 'env_1', connected)).toEqual(connected)
    expect((await store.environments.list(A, { limit: 20 })).data).toEqual([connected])
    expect((await store.environments.list(B, { limit: 20 })).data).toEqual([])
    expect(await store.templates.delete(A, 'tpl_1')).toBe(true)
  })

  it('files: another owner cannot read, claim, release, or delete a staged file', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    await store.files.insert(fileRow('file_a', A))
    expect(await store.files.get('file_a', A)).toEqual(fileRow('file_a', A))
    expect(await store.files.get('file_a', B)).toBeUndefined()
    expect(await store.files.getMany(B, ['file_a'])).toEqual([])
    expect(await store.files.claim(B, ['file_a'], 'sess_1')).toBeUndefined()
    expect(await store.files.deleteStaged('file_a', B)).toBeUndefined()
    expect((await store.files.get('file_a', A))?.status).toBe('staged')
    await expect(store.files.insert(fileRow('file_a', A))).rejects.toThrow()
    await expect(store.files.insert(fileRow('file_x', ownerId('nobody')))).rejects.toThrow()
  })

  it('files: claim is all or nothing and a second claim of the same file loses', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.files.insert(fileRow('file_1', A))
    await store.files.insert(fileRow('file_2', A))
    expect(await store.files.claim(A, ['file_1', 'file_missing'], 'sess_1')).toBeUndefined()
    expect((await store.files.get('file_1', A))?.status).toBe('staged')
    expect(await store.files.claim(A, ['file_1', 'file_1'], 'sess_1')).toBeUndefined()
    const claimed = await store.files.claim(A, ['file_2', 'file_1'], 'sess_1')
    expect(claimed?.map(row => row.id)).toEqual(['file_2', 'file_1'])
    expect(claimed?.every(row => row.status === 'attached' && row.sessionId === 'sess_1' && row.attachedAt !== null)).toBe(true)
    expect(await store.files.claim(A, ['file_1'], 'sess_2')).toBeUndefined()
    const raced = await Promise.all([store.files.insert(fileRow('file_r', A)).then(() => store.files.claim(A, ['file_r'], 's1')), store.files.claim(A, ['file_r'], 's2')])
    expect(raced.filter(result => result !== undefined).length).toBeLessThanOrEqual(1)
  })

  it('files: markAttached, listForSession, release, and deleteStaged on an attached row', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    await store.files.insert(fileRow('file_1', A))
    await store.files.claim(A, ['file_1'], 'sess_1')
    expect(await store.files.listForSession(A, 'sess_1')).toEqual([])
    const attachment = { kind: 'file' as const, ref: { attachmentId: AttachmentId('abc'), name: 'notes.txt', bytes: 100 } }
    await store.files.markAttached('file_1', B, { attachment, workspacePath: 'uploads/other.txt' })
    expect(await store.files.listForSession(A, 'sess_1')).toEqual([])
    await store.files.markAttached('file_1', A, { attachment, workspacePath: 'uploads/notes.txt' })
    const listed = await store.files.listForSession(A, 'sess_1')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: 'file_1', attachment, workspacePath: 'uploads/notes.txt', status: 'attached' })
    expect(await store.files.listForSession(B, 'sess_1')).toEqual([])
    expect(await store.files.deleteStaged('file_1', A)).toBe('attached')
    expect(await store.files.stagedBytes(A)).toBe(0)
    await store.files.release(B, ['file_1'])
    expect((await store.files.get('file_1', A))?.status).toBe('attached')
    await store.files.release(A, ['file_1'])
    expect(await store.files.get('file_1', A)).toEqual(fileRow('file_1', A))
    expect(await store.files.stagedBytes(A)).toBe(100)
  })

  it('files: staged bytes, expiry, staged ids, and session cleanup', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    await store.files.insert(fileRow('file_old', A, { createdAt: new Date('2026-11-08T00:00:00.000Z'), bytes: 10 }))
    await store.files.insert(fileRow('file_new', A, { bytes: 20 }))
    await store.files.insert(fileRow('file_b', B, { createdAt: new Date('2026-11-07T00:00:00.000Z'), bytes: 5 }))
    await store.files.insert(fileRow('file_att', A, { createdAt: new Date('2026-11-01T00:00:00.000Z') }))
    await store.files.claim(A, ['file_att'], 'sess_9')
    expect(await store.files.stagedBytes(A)).toBe(30)
    expect(await store.files.stagedBytes(B)).toBe(5)
    expect(await store.files.stagedIds(['file_old', 'file_att', 'file_nope'])).toEqual(new Set(['file_old']))
    expect(await store.files.stagedIds([])).toEqual(new Set())
    const expired = await store.files.expireStaged(new Date('2026-11-09T00:00:00.000Z'))
    expect(expired.map(row => row.id).sort()).toEqual(['file_b', 'file_old'])
    expect(await store.files.get('file_old', A)).toBeUndefined()
    expect((await store.files.get('file_att', A))?.status).toBe('attached')
    expect(await store.files.deleteForSession(B, 'sess_9')).toBe(0)
    expect(await store.files.deleteForSession(A, 'sess_9')).toBe(1)
    expect(await store.files.get('file_att', A)).toBeUndefined()
    expect(await store.files.deleteStaged('file_new', A)).toMatchObject({ id: 'file_new' })
    expect(await store.files.deleteStaged('file_new', A)).toBeUndefined()
  })

  it('reads, updates, and deletes session rows per owner', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    const row = sessionRow('sess_1', A, { agentId: 'agent_1', reasoningEffort: 'low' })
    await store.sessions.insert(row)
    expect(await store.sessions.get('sess_1', A)).toEqual(row)
    expect(await store.sessions.get('sess_1', 'any')).toEqual(row)
    expect(await store.sessions.get('sess_1', B)).toBeUndefined()
    expect(await store.sessions.update('sess_1', B, { status: 'failed' })).toBeUndefined()
    const at = new Date('2020-01-01T00:00:00.000Z')
    const updated = await store.sessions.update('sess_1', A, { status: 'failed', lastError: 'boom', model: 'deepseek-v4', updatedAt: at })
    expect(updated).toEqual({ ...row, status: 'failed', lastError: 'boom', model: 'deepseek-v4', updatedAt: at })
    const cleared = await store.sessions.update('sess_1', 'any', { lastError: null, reasoningEffort: null })
    expect(cleared).toMatchObject({ lastError: null, reasoningEffort: null, status: 'failed' })
    expect(cleared!.updatedAt.getTime()).toBeGreaterThan(at.getTime())
    expect(await store.sessions.update('missing', 'any', { status: 'idle' })).toBeUndefined()
    expect(await store.sessions.delete('sess_1', B)).toBe(false)
    expect(await store.sessions.delete('sess_1', A)).toBe(true)
    expect(await store.sessions.get('sess_1', 'any')).toBeUndefined()
  })

  it('sessions keep the resolved setup in body; rows without one read back null', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    const body: SessionConfig = {
      agent: materializeAgent({ model: 'deepseek-chat', instructions: 'be brief' }),
      environment: { type: 'local', workspace_directory: '/w/sess_b' },
      metadata: { k: 'v' },
      vault_ids: ['vault_1'],
    }
    await store.sessions.insert(sessionRow('sess_b', A, { body }))
    await store.sessions.insert(sessionRow('sess_n', A))
    expect((await store.sessions.get('sess_b', A))?.body).toEqual(body)
    expect((await store.sessions.get('sess_n', A))?.body).toBeNull()
    const next: SessionConfig = { ...body, metadata: {} }
    expect((await store.sessions.update('sess_n', A, { body: next }))?.body).toEqual(next)
    expect((await store.sessions.update('sess_b', A, { status: 'failed' }))?.body).toEqual(body)
  })

  it('sessions.list filters by owner, agent, status, and time, newest first, in disjoint cursor pages', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 10, minute))
    await store.sessions.insert(sessionRow('sess_a1', A, { createdAt: at(1), agentId: 'agent_x' }))
    await store.sessions.insert(sessionRow('sess_a2', A, { createdAt: at(2), status: 'in_progress' }))
    await store.sessions.insert(sessionRow('sess_a3', A, { createdAt: at(3), agentId: 'agent_x', status: 'in_progress' }))
    // Same createdAt: order falls back to id, descending.
    await store.sessions.insert(sessionRow('sess_a4b', A, { createdAt: at(4) }))
    await store.sessions.insert(sessionRow('sess_a4a', A, { createdAt: at(4) }))
    await store.sessions.insert(sessionRow('sess_b1', B, { createdAt: at(5), agentId: 'agent_x' }))

    const ids = (rows: { data: SessionIndexRow[] }) => rows.data.map(row => row.id)
    expect(ids(await store.sessions.list({ owner: A, limit: 20 }))).toEqual(['sess_a4b', 'sess_a4a', 'sess_a3', 'sess_a2', 'sess_a1'])
    expect(ids(await store.sessions.list({ owner: 'any', limit: 20, agentId: 'agent_x' }))).toEqual(['sess_b1', 'sess_a3', 'sess_a1'])
    expect(ids(await store.sessions.list({ owner: A, limit: 20, status: 'in_progress' }))).toEqual(['sess_a3', 'sess_a2'])
    expect(ids(await store.sessions.list({ owner: A, limit: 20, from: at(2), to: at(4) }))).toEqual(['sess_a3', 'sess_a2'])

    const seen: string[] = []
    let cursor: string | null | undefined
    let pages = 0
    do {
      const page = await store.sessions.list({ owner: A, limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...ids(page))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== null)
    expect(pages).toBe(3)
    expect(seen).toEqual(['sess_a4b', 'sess_a4a', 'sess_a3', 'sess_a2', 'sess_a1'])
    const last = await store.sessions.list({ owner: A, limit: 5 })
    expect(last.nextCursor).toBeNull()

    await expect(store.sessions.list({ owner: A, limit: 2, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(InvalidCursorError)
  })

  it('listResumable returns in_progress and requires_action only, across owners', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    const statuses: Array<SessionIndexRow['status']> = ['idle', 'in_progress', 'requires_action', 'failed', 'interrupted']
    for (const [index, status] of statuses.entries()) {
      await store.sessions.insert(sessionRow(`sess_${status}`, index % 2 === 0 ? A : B, {
        status,
        createdAt: new Date(Date.UTC(2026, 10, 8, 10, index)),
      }))
    }
    expect((await store.sessions.listResumable()).map(row => row.id)).toEqual(['sess_in_progress', 'sess_requires_action'])
  })

  it('ownersOf returns the owner of existing ids only, and an empty map for no ids', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await store.ensureOwner(B)
    await store.sessions.insert(sessionRow('sess_o1', A))
    await store.sessions.insert(sessionRow('sess_o2', B))
    expect(await store.sessions.ownersOf(['sess_o1', 'sess_missing', 'sess_o2'])).toEqual(new Map([['sess_o1', A], ['sess_o2', B]]))
    expect(await store.sessions.ownersOf([])).toEqual(new Map())
  })

  it('accepts audit entries', async () => {
    const store = await harness.fresh()
    await store.ensureOwner(A)
    await expect(store.audit({ actor: A, action: 'sessions.list', target: '*' })).resolves.toBeUndefined()
  })
})

describe('Postgres migrations', () => {
  it('migrations apply from empty', async () => {
    const url = await postgres!.createDatabase('empty')
    expect(await migrate(url)).toEqual({ applied: ['0001-initial.sql', '0002-session-config.sql', '0003-files.sql'] })
    expect(await migrate(url)).toEqual({ applied: [] })
  })

  it('migrations are idempotent under concurrent start', async () => {
    const url = await postgres!.createDatabase('concurrent')
    const results = await Promise.all([migrate(url), migrate(url)])
    expect(results.flatMap(result => result.applied)).toEqual(['0001-initial.sql', '0002-session-config.sql', '0003-files.sql'])
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      const rows = await client.query<{ name: string }>('select name from schema_migrations')
      expect(rows.rows.map(row => row.name)).toEqual(['0001-initial.sql', '0002-session-config.sql', '0003-files.sql'])
    } finally {
      await client.end()
    }
  })

  it('creates the spec tables and indexes', async () => {
    const client = new pg.Client({ connectionString: await contractUrl() })
    await client.connect()
    try {
      const tables = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
      )
      expect(tables.rows.map(row => row.table_name)).toEqual([
        'admin_audit', 'agents', 'environment_templates', 'environments', 'files', 'owners', 'schema_migrations', 'sessions',
      ])
      const indexes = await client.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where schemaname = 'public' and indexname like '%\\_idx' order by indexname",
      )
      expect(indexes.rows.map(row => row.indexdef.replace(/^.* USING btree /u, ''))).toEqual([
        '(owner_id, created_at DESC)',
        '(owner_id, created_at DESC)',
        '(owner_id, created_at DESC)',
        '(owner_id, session_id, attachment_id)',
        '(owner_id, status, created_at)',
        '(owner_id, created_at DESC)',
        '(status)',
      ])
    } finally {
      await client.end()
    }
  })

  it('rejects calls after close', async () => {
    const url = await postgres!.createDatabase('closed')
    await migrate(url)
    const store = await openPostgresStore(url)
    await store.close()
    await expect(store.ensureOwner(A)).rejects.toThrow()
  })
})

describe('guardStore', () => {
  it('turns an ownersOf failure into StoreUnavailableError', async () => {
    const store = new MemoryStore()
    store.sessions.ownersOf = () => Promise.reject(new Error('connection refused'))
    await expect(guardStore(store).sessions.ownersOf(['sess_1'])).rejects.toBeInstanceOf(StoreUnavailableError)
  })
})
