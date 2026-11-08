/**
 * In-memory `Store` with the Postgres store's owner scoping, ordering, and
 * pagination. `tests/store.spec.ts` runs the same cases against both.
 */

import type { OwnerId } from '../../src/auth/authenticator.ts'
import type { EnvironmentRecord, EnvironmentTemplate } from '../../src/environment-types.ts'
import type { ListQuery } from '../../src/http.ts'
import {
  RESUMABLE_STATUSES,
  decodeSessionCursor,
  encodeSessionCursor,
  type OwnedCollection,
  type SessionIndexPatch,
  type SessionIndexRow,
  type SessionListQuery,
  type Store,
} from '../../src/store/store.ts'
import type { OAIAgent, OAIListResponse } from '../../src/types.ts'

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
      for (const key of ['agentId', 'environmentId', 'dshSessionId', 'status', 'lastError', 'model', 'reasoningEffort', 'body'] as const) {
        if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key]
      }
      next.updatedAt = patch.updatedAt ?? new Date()
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
        .filter(row => q.status === undefined || row.status === q.status)
        .filter(row => q.from === undefined || row.createdAt.getTime() >= q.from.getTime())
        .filter(row => q.to === undefined || row.createdAt.getTime() < q.to.getTime())
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
