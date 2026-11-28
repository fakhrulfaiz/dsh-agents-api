/**
 * In-memory `Store` with the Postgres store's owner scoping, ordering, and
 * pagination. `tests/store.spec.ts` runs the same cases against both.
 */

import type { OwnerId } from '../../src/auth/authenticator.ts'
import type { EnvironmentRecord, EnvironmentTemplate } from '../../src/environment-types.ts'
import type { ListQuery } from '../../src/http.ts'
import {
  RESUMABLE_STATUSES,
  SkillNameTakenError,
  type SkillCollection,
  type SecretCollection,
  type SecretRow,
  type SkillRow,
  type FileCollection,
  type FileRow,
  decodeSessionCursor,
  encodeSessionCursor,
  type LibrarySource,
  type OwnedCollection,
  type ProjectCollection,
  type SessionIndexPatch,
  type SessionIndexRow,
  type SessionListQuery,
  type Store,
} from '../../src/store/store.ts'
import type { OAIAgent, OAIListResponse, OAIProject, ProjectListQuery } from '../../src/types.ts'

interface Entry<T> {
  owner: OwnerId
  value: T
  /** Insertion order; stands in for the Postgres insertion timestamp. */
  seq: number
}

/** Compare by insertion order, then id. */
function byInsertion<T extends { id: string }>(a: Entry<T>, b: Entry<T>): number {
  return a.seq - b.seq || (a.value.id < b.value.id ? -1 : a.value.id > b.value.id ? 1 : 0)
}

/** Compare session rows newest first: `createdAt` desc, then `id` desc. */
function newestFirst(a: SessionIndexRow, b: SessionIndexRow): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

/** Copy a session row, including its stored setup. */
function cloneRow(row: SessionIndexRow): SessionIndexRow {
  return structuredClone(row)
}

/** Fake `Store`. Set `failure` to make every call reject with it. */
export class MemoryStore implements Store {
  /** When set, every method rejects with this error. */
  failure: Error | undefined
  readonly #owners = new Set<OwnerId>()
  readonly #sessions = new Map<string, SessionIndexRow>()
  readonly #audit: Array<{ actor: OwnerId; action: string; target: string; at: Date }> = []
  #seq = 0
  #closed = false

  readonly agents: OwnedCollection<OAIAgent> = this.#collection<OAIAgent>()
  readonly templates: OwnedCollection<EnvironmentTemplate> = this.#collection<EnvironmentTemplate>()
  readonly environments: OwnedCollection<EnvironmentRecord> = this.#collection<EnvironmentRecord>()
  readonly librarySources: OwnedCollection<LibrarySource> = this.#collection<LibrarySource>()

  readonly #projects = new Map<string, Entry<OAIProject>>()

  readonly projects: ProjectCollection = {
    create: async (owner, value) => {
      this.#check()
      this.#requireOwner(owner)
      if (this.#projects.has(value.id)) throw new Error(`duplicate project ${value.id}`)
      this.#projects.set(value.id, { owner, value: structuredClone(value), seq: this.#seq++ })
      return structuredClone(value)
    },
    get: async (owner, id) => {
      this.#check()
      const entry = this.#projects.get(id)
      return entry !== undefined && entry.owner === owner ? structuredClone(entry.value) : undefined
    },
    update: async (owner, id, value) => {
      this.#check()
      const entry = this.#projects.get(id)
      if (entry === undefined || entry.owner !== owner) return undefined
      entry.value = structuredClone(value)
      return structuredClone(value)
    },
    delete: async (owner, id) => {
      this.#check()
      const entry = this.#projects.get(id)
      if (entry === undefined || entry.owner !== owner) return false
      return this.#projects.delete(id)
    },
    list: async (q: ProjectListQuery) => {
      this.#check()
      const limit = q.limit ?? 20
      const status = q.status ?? 'active'
      let rows = [...this.#projects.values()]
        .filter(entry => entry.owner === q.owner && (status === 'all' || entry.value.status === status))
        .sort(byInsertion)
      if (q.order !== 'asc') rows.reverse()
      if (q.after !== undefined) {
        const cursor = rows.findIndex(entry => entry.value.id === q.after)
        if (cursor !== -1) rows = rows.slice(cursor + 1)
      }
      const data = rows.slice(0, limit).map(entry => structuredClone(entry.value))
      return {
        object: 'list' as const,
        data,
        first_id: data[0]?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
        has_more: rows.length > limit,
      }
    },
    countSessions: async (owner, id) => {
      this.#check()
      const entry = this.#projects.get(id)
      if (entry === undefined || entry.owner !== owner) return 0
      return [...this.#sessions.values()].filter(row => row.ownerId === owner && row.projectId === id).length
    },
  }

  readonly #secrets = new Map<string, SecretRow>()
  readonly secrets: SecretCollection = {
    get: (owner, name) => this.#async(() => {
      const row = this.#secrets.get(`${owner}\0${name}`)
      return row === undefined ? undefined : { ...row }
    }),
    put: (owner, name, value) => this.#async(() => {
      this.#requireOwner(owner)
      const id = `${owner}\0${name}`
      const now = Math.floor(Date.now() / 1000)
      const row: SecretRow = { ...value, created_at: this.#secrets.get(id)?.created_at ?? now, updated_at: now }
      this.#secrets.set(id, row)
      return { ...row }
    }),
    delete: (owner, name) => this.#async(() => this.#secrets.delete(`${owner}\0${name}`)),
  }

  readonly #skills = new Map<string, SkillRow>()

  readonly skills: SkillCollection = {
    insert: (row) => {
      if (this.#skills.has(row.id)) return Promise.reject(new Error(`duplicate skill ${row.id}`))
      for (const other of this.#skills.values()) if (other.owner === row.owner && other.name === row.name) return Promise.reject(new SkillNameTakenError(row.name))
      this.#skills.set(row.id, structuredClone(row))
      return Promise.resolve()
    },
    get: (id, owner) => {
      const row = this.#skills.get(id)
      return Promise.resolve(row !== undefined && row.owner === owner ? structuredClone(row) : undefined)
    },
    list: (owner, filter = {}) => Promise.resolve([...this.#skills.values()]
      .filter(r => r.owner === owner && (filter.scope === undefined || r.scope === filter.scope) && (filter.agentId === undefined || r.agent_id === filter.agentId) && (filter.status === undefined || r.status === filter.status))
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
      .map(r => structuredClone(r))),
    update: (id, owner, patch) => {
      const row = this.#skills.get(id)
      if (row === undefined || row.owner !== owner) return Promise.resolve(undefined)
      const next = { ...row, ...structuredClone(patch) }
      this.#skills.set(id, next)
      return Promise.resolve(structuredClone(next))
    },
    delete: (id, owner) => {
      const row = this.#skills.get(id)
      if (row === undefined || row.owner !== owner) return Promise.resolve(undefined)
      this.#skills.delete(id)
      return Promise.resolve(row)
    },
    deleteStagedBefore: (cutoff) => {
      const removed = [...this.#skills.values()].filter(r => r.status === 'pending_review' && r.updated_at < cutoff)
      for (const r of removed) this.#skills.delete(r.id)
      return Promise.resolve(removed)
    },
  }

  readonly #files = new Map<string, FileRow>()

  readonly files: FileCollection = {
    insert: async (row) => {
      this.#check()
      this.#requireOwner(row.ownerId)
      if (this.#files.has(row.id)) throw new Error(`duplicate file ${row.id}`)
      this.#files.set(row.id, structuredClone(row))
    },
    get: async (id, owner) => {
      this.#check()
      const row = this.#files.get(id)
      return row !== undefined && row.ownerId === owner ? structuredClone(row) : undefined
    },
    getMany: async (owner, ids) => {
      this.#check()
      return ids.flatMap((id) => {
        const row = this.#files.get(id)
        return row !== undefined && row.ownerId === owner ? [structuredClone(row)] : []
      })
    },
    deleteStaged: async (id, owner) => {
      this.#check()
      const row = this.#files.get(id)
      if (row === undefined || row.ownerId !== owner) return undefined
      if (row.status !== 'staged') return 'attached'
      this.#files.delete(id)
      return structuredClone(row)
    },
    stagedBytes: async (owner) => {
      this.#check()
      return [...this.#files.values()].filter(row => row.ownerId === owner && row.status === 'staged').reduce((sum, row) => sum + row.bytes, 0)
    },
    claim: async (owner, ids, sessionId) => {
      this.#check()
      const rows = ids.map(id => this.#files.get(id))
      if (rows.some(row => row === undefined || row.ownerId !== owner || row.status !== 'staged') || new Set(ids).size !== ids.length) return undefined
      const now = new Date()
      return rows.map((row) => {
        row!.status = 'attached'
        row!.sessionId = sessionId
        row!.attachedAt = now
        return structuredClone(row!)
      })
    },
    markAttached: async (id, owner, patch) => {
      this.#check()
      const row = this.#files.get(id)
      if (row === undefined || row.ownerId !== owner || row.status !== 'attached') return
      row.attachment = structuredClone(patch.attachment)
      row.workspacePath = patch.workspacePath
    },
    release: async (owner, ids) => {
      this.#check()
      for (const id of ids) {
        const row = this.#files.get(id)
        if (row === undefined || row.ownerId !== owner || row.status !== 'attached') continue
        row.status = 'staged'
        row.sessionId = null
        row.attachment = null
        row.workspacePath = null
        row.attachedAt = null
      }
    },
    list: async (owner, q) => {
      this.#check()
      const rows = [...this.#files.values()]
        .filter(row => row.ownerId === owner && (q.status === undefined || row.status === q.status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      const start = q.after === undefined ? -1 : rows.findIndex(row => row.id === q.after)
      const page = rows.slice(start + 1, start + 1 + q.limit)
      return { data: page.map(row => structuredClone(row)), hasMore: rows.length > start + 1 + q.limit }
    },
    listForSession: async (owner, sessionId) => {
      this.#check()
      return [...this.#files.values()]
        .filter(row => row.ownerId === owner && row.sessionId === sessionId && row.status === 'attached' && row.attachment !== null)
        .sort((a, b) => (a.attachedAt?.getTime() ?? 0) - (b.attachedAt?.getTime() ?? 0) || (a.id < b.id ? -1 : 1))
        .map(row => structuredClone(row))
    },
    deleteForSession: async (owner, sessionId) => {
      this.#check()
      let removed = 0
      for (const [id, row] of this.#files) {
        if (row.ownerId === owner && row.sessionId === sessionId) {
          this.#files.delete(id)
          removed += 1
        }
      }
      return removed
    },
    expireStaged: async (before) => {
      this.#check()
      const expired: FileRow[] = []
      for (const [id, row] of this.#files) {
        if (row.status === 'staged' && row.createdAt.getTime() < before.getTime()) {
          this.#files.delete(id)
          expired.push(structuredClone(row))
        }
      }
      return expired
    },
    stagedIds: async (ids) => {
      this.#check()
      return new Set(ids.filter(id => this.#files.get(id)?.status === 'staged'))
    },
  }

  readonly sessions: Store['sessions'] = {
    insert: async (row) => {
      this.#check()
      this.#requireOwner(row.ownerId)
      if (this.#sessions.has(row.id)) throw new Error(`duplicate session ${row.id}`)
      this.#sessions.set(row.id, cloneRow(row))
    },
    update: async (id, owner, patch: SessionIndexPatch) => {
      this.#check()
      const row = this.#session(id, owner)
      if (row === undefined) return undefined
      const next: SessionIndexRow = cloneRow(row)
      for (const key of ['agentId', 'environmentId', 'projectId', 'dshSessionId', 'status', 'lastError', 'model', 'reasoningEffort', 'body'] as const) {
        if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key]
      }
      next.updatedAt = patch.updatedAt ?? new Date()
      this.#sessions.set(id, next)
      return cloneRow(next)
    },
    mergeMetadata: async (id, owner, patch) => {
      this.#check()
      const row = this.#session(id, owner)
      if (row === undefined || row.body === null) return undefined
      const metadata: Record<string, string> = { ...row.body.metadata }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete metadata[key]
        else metadata[key] = value
      }
      const next: SessionIndexRow = { ...cloneRow(row), body: { ...row.body, metadata }, updatedAt: new Date() }
      this.#sessions.set(id, next)
      return cloneRow(next)
    },
    get: async (id, owner) => {
      this.#check()
      const row = this.#session(id, owner)
      return row === undefined ? undefined : cloneRow(row)
    },
    delete: async (id, owner) => {
      this.#check()
      if (this.#session(id, owner) === undefined) return false
      return this.#sessions.delete(id)
    },
    list: async (q: SessionListQuery) => {
      this.#check()
      const after = q.cursor === undefined ? undefined : decodeSessionCursor(q.cursor)
      const rows = [...this.#sessions.values()]
        .filter(row => q.owner === 'any' || row.ownerId === q.owner)
        .filter(row => q.agentId === undefined || row.agentId === q.agentId)
        .filter(row => q.projectId === undefined || row.projectId === q.projectId)
        .filter(row => q.status === undefined || row.status === q.status)
        .filter(row => q.from === undefined || row.createdAt.getTime() >= q.from.getTime())
        .filter(row => q.to === undefined || row.createdAt.getTime() < q.to.getTime())
        .filter(row => Object.entries(q.metadata ?? {}).every(([key, value]) => row.body?.metadata[key] === value))
        .filter(row => after === undefined || newestFirst(row, { ...row, createdAt: after.createdAt, id: after.id }) > 0)
        .sort(newestFirst)
      const data = rows.slice(0, q.limit).map(cloneRow)
      const last = data.at(-1)
      return {
        data,
        nextCursor: rows.length > q.limit && last !== undefined ? encodeSessionCursor(last.createdAt, last.id) : null,
      }
    },
    listResumable: async () => {
      this.#check()
      return [...this.#sessions.values()]
        .filter(row => RESUMABLE_STATUSES.includes(row.status))
        .sort((a, b) => newestFirst(b, a))
        .map(cloneRow)
    },
    ownersOf: async ids => {
      this.#check()
      const owners = new Map<string, OwnerId>()
      for (const id of ids) {
        const row = this.#sessions.get(id)
        if (row !== undefined) owners.set(id, row.ownerId)
      }
      return owners
    },
  }

  /** Audit rows written so far. */
  get auditLog(): ReadonlyArray<{ actor: OwnerId; action: string; target: string; at: Date }> {
    return this.#audit
  }

  async ensureOwner(owner: OwnerId): Promise<void> {
    this.#check()
    this.#owners.add(owner)
  }

  async audit(entry: { actor: OwnerId; action: string; target: string }): Promise<void> {
    this.#check()
    this.#audit.push({ ...entry, at: new Date() })
  }

  async close(): Promise<void> {
    this.#closed = true
  }

  #async<T>(run: () => T): Promise<T> {
    try {
      this.#check()
      return Promise.resolve(run())
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  #check(): void {
    if (this.failure !== undefined) throw this.failure
    if (this.#closed) throw new Error('store is closed')
  }

  #requireOwner(owner: OwnerId): void {
    if (!this.#owners.has(owner)) throw new Error(`owner ${owner} does not exist`)
  }

  #session(id: string, owner: OwnerId | 'any'): SessionIndexRow | undefined {
    const row = this.#sessions.get(id)
    return row !== undefined && (owner === 'any' || row.ownerId === owner) ? row : undefined
  }

  #collection<T extends { id: string }>(): OwnedCollection<T> {
    const entries = new Map<string, Entry<T>>()
    const owned = (owner: OwnerId, id: string) => {
      const entry = entries.get(id)
      return entry !== undefined && entry.owner === owner ? entry : undefined
    }
    const clone = (value: T): T => structuredClone(value)
    return {
      create: async (owner, value) => {
        this.#check()
        this.#requireOwner(owner)
        if (entries.has(value.id)) throw new Error(`duplicate id ${value.id}`)
        entries.set(value.id, { owner, value: clone(value), seq: this.#seq++ })
        return clone(value)
      },
      get: async (owner, id) => {
        this.#check()
        const entry = owned(owner, id)
        return entry === undefined ? undefined : clone(entry.value)
      },
      update: async (owner, id, value) => {
        this.#check()
        const entry = owned(owner, id)
        if (entry === undefined) return undefined
        entry.value = clone(value)
        return clone(value)
      },
      delete: async (owner, id) => {
        this.#check()
        if (owned(owner, id) === undefined) return false
        return entries.delete(id)
      },
      list: async (owner: OwnerId, q: ListQuery): Promise<OAIListResponse<T>> => {
        this.#check()
        let rows = [...entries.values()].filter(entry => entry.owner === owner).sort(byInsertion)
        if (q.order !== 'asc') rows.reverse()
        const cursor = q.after === undefined ? -1 : rows.findIndex(entry => entry.value.id === q.after)
        if (cursor !== -1) rows = rows.slice(cursor + 1)
        const data = rows.slice(0, q.limit).map(entry => clone(entry.value))
        return {
          object: 'list',
          data,
          first_id: data[0]?.id ?? null,
          last_id: data.at(-1)?.id ?? null,
          has_more: rows.length > q.limit,
        }
      },
    }
  }
}
