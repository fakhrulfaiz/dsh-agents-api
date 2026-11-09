/**
 * Durable Agentry records: owners, saved agents, environment templates,
 * environments, the session index, and the admin audit log.
 *
 * Every owner-scoped read and write takes the caller's `OwnerId`; a record of
 * another owner reads as absent. Items, turns, and steps are not stored here:
 * the DSH Session log is their source of truth.
 */

import type { OwnerId } from '../auth/authenticator.ts'
import type { EnvironmentRecord, EnvironmentTemplate } from '../environment-types.ts'
import type { ListQuery } from '../http.ts'
import type { OAIAgent, OAIListResponse, SessionConfig, SessionStatus } from '../types.ts'

/** One row of the session index. Model-visible history stays in the DSH Session log. */
export interface SessionIndexRow {
  id: string
  ownerId: OwnerId
  agentId: string | null
  environmentId: string | null
  dshSessionId: string
  status: SessionStatus | 'interrupted'
  lastError: string | null
  model: string
  reasoningEffort: string | null
  /** Resolved setup needed to rebuild the agent on resume; `null` for rows written before migration 0002, which cannot be resumed. */
  body: SessionConfig | null
  createdAt: Date
  updatedAt: Date
}

/** Session index fields `sessions.update` may change. `updatedAt` is set to the update time when omitted. */
export type SessionIndexPatch = Partial<Omit<SessionIndexRow, 'id' | 'ownerId' | 'createdAt'>>

/**
 * Owner-scoped records keyed by `id`.
 *
 * `list` orders by insertion time, then `id`, newest first unless `order` is
 * `asc`. `after` names the last id of the previous page; an id the owner does
 * not hold is ignored and the list starts from the beginning.
 */
export interface OwnedCollection<T extends { id: string }> {
  /**
   * Insert a record. The owner must exist (`ensureOwner`).
   * @param owner - owning principal.
   * @param value - record; `value.id` must be new.
   * @returns the stored record.
   */
  create(owner: OwnerId, value: T): Promise<T>
  /**
   * @param owner - calling principal.
   * @param id - record id.
   * @returns the record, or `undefined` when missing or owned by someone else.
   */
  get(owner: OwnerId, id: string): Promise<T | undefined>
  /**
   * Replace a record.
   * @param owner - calling principal.
   * @param id - record id.
   * @param value - full replacement.
   * @returns the stored record, or `undefined` when missing or owned by someone else.
   */
  update(owner: OwnerId, id: string, value: T): Promise<T | undefined>
  /**
   * @param owner - calling principal.
   * @param id - record id.
   * @returns whether a record of `owner` was deleted.
   */
  delete(owner: OwnerId, id: string): Promise<boolean>
  /**
   * @param owner - calling principal.
   * @param q - limit, `after`, and order.
   * @returns one page of the owner's records.
   */
  list(owner: OwnerId, q: ListQuery): Promise<OAIListResponse<T>>
}

/**
 * Session index filters. Rows are ordered by `createdAt`, then `id`, newest
 * first. `from` is inclusive and `to` exclusive; `cursor` is the `nextCursor`
 * of the previous page.
 */
export interface SessionListQuery {
  owner: OwnerId | 'any'
  agentId?: string
  status?: string
  from?: Date
  to?: Date
  cursor?: string
  limit: number
}

/** Agentry's durable storage. Rejections mean the backing database failed, except `InvalidCursorError`. */
export interface Store {
  /**
   * Record an owner. Idempotent.
   * @param owner - authenticated owner id.
   */
  ensureOwner(owner: OwnerId): Promise<void>
  agents: OwnedCollection<OAIAgent>
  templates: OwnedCollection<EnvironmentTemplate>
  environments: OwnedCollection<EnvironmentRecord>
  sessions: {
    /**
     * @param row - new index row; its owner must exist.
     */
    insert(row: SessionIndexRow): Promise<void>
    /**
     * @param id - session id.
     * @param owner - calling principal, or `'any'` for internal and admin callers.
     * @param patch - changed fields.
     * @returns the updated row, or `undefined` when missing or owned by someone else.
     */
    update(id: string, owner: OwnerId | 'any', patch: SessionIndexPatch): Promise<SessionIndexRow | undefined>
    /**
     * @param id - session id.
     * @param owner - calling principal, or `'any'`.
     * @returns the row, or `undefined` when missing or owned by someone else.
     */
    get(id: string, owner: OwnerId | 'any'): Promise<SessionIndexRow | undefined>
    /**
     * @param id - session id.
     * @param owner - calling principal, or `'any'`.
     * @returns whether a row was deleted.
     */
    delete(id: string, owner: OwnerId | 'any'): Promise<boolean>
    /**
     * @param q - filters and page cursor.
     * @returns one page, newest first, and the cursor of the next page or `null` on the last page.
     * @throws InvalidCursorError when `q.cursor` was not produced by this store.
     */
    list(q: SessionListQuery): Promise<{ data: SessionIndexRow[]; nextCursor: string | null }>
    /**
     * @returns rows of every owner whose status is `in_progress` or `requires_action`, oldest first.
     */
    listResumable(): Promise<SessionIndexRow[]>
    /**
     * @param ids - session ids to look up.
     * @returns owner by id for the ids that exist; unknown ids are absent. An empty input returns an empty map.
     */
    ownersOf(ids: readonly string[]): Promise<Map<string, OwnerId>>
  }
  /**
   * Append one admin audit row stamped with the current time.
   * @param entry - acting owner, action name, and target id.
   */
  audit(entry: { actor: OwnerId; action: string; target: string }): Promise<void>
  /** Release connections. Later calls reject. */
  close(): Promise<void>
}

/** Statuses `listResumable` returns. */
export const RESUMABLE_STATUSES: readonly string[] = ['in_progress', 'requires_action']

/** A session list cursor that this store did not produce. Maps to HTTP 400. */
export class InvalidCursorError extends Error {
  /** @param cursor - rejected cursor text. */
  constructor(cursor: string) {
    super(`invalid cursor: ${cursor}`)
    this.name = 'InvalidCursorError'
  }
}

/** The backing database rejected a call. Maps to HTTP 503 `store_unavailable`. */
export class StoreUnavailableError extends Error {
  /** @param cause - the rejection from the store implementation. */
  constructor(cause: unknown) {
    super(`agents store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'StoreUnavailableError'
  }
}

/**
 * Encode a session list cursor: base64 of `<createdAt ISO>|<id>`.
 * @param createdAt - `createdAt` of the last row on the page.
 * @param id - `id` of that row.
 * @returns opaque cursor text.
 */
export function encodeSessionCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64')
}

/**
 * Decode a cursor from `encodeSessionCursor`.
 * @param cursor - opaque cursor text.
 * @returns the row position the next page starts after.
 * @throws InvalidCursorError when the text is not such a cursor.
 */
export function decodeSessionCursor(cursor: string): { createdAt: Date; id: string } {
  const text = Buffer.from(cursor, 'base64').toString('utf8')
  const bar = text.indexOf('|')
  const createdAt = new Date(bar === -1 ? Number.NaN : text.slice(0, bar))
  const id = text.slice(bar + 1)
  if (bar === -1 || Number.isNaN(createdAt.getTime()) || id === '' || encodeSessionCursor(createdAt, id) !== cursor) {
    throw new InvalidCursorError(cursor)
  }
  return { createdAt, id }
}

/**
 * Wrap a promise-returning method so any rejection other than
 * `InvalidCursorError` becomes `StoreUnavailableError`.
 * @param call - store method bound to its receiver.
 * @returns the guarded method.
 */
function guard<A extends unknown[], R>(call: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await call(...args)
    } catch (error: unknown) {
      if (error instanceof InvalidCursorError || error instanceof StoreUnavailableError) throw error
      throw new StoreUnavailableError(error)
    }
  }
}

/**
 * Guard every method of a collection.
 * @param collection - owner-scoped collection.
 * @returns the same collection with outage rejections normalized.
 */
function guardCollection<T extends { id: string }>(collection: OwnedCollection<T>): OwnedCollection<T> {
  return {
    create: guard(collection.create.bind(collection)),
    get: guard(collection.get.bind(collection)),
    update: guard(collection.update.bind(collection)),
    delete: guard(collection.delete.bind(collection)),
    list: guard(collection.list.bind(collection)),
  }
}

/**
 * View of `store` whose rejections are `StoreUnavailableError` (or
 * `InvalidCursorError`), so a route handler can answer 503 without knowing
 * the implementation's error types.
 * @param store - Postgres store or a test fake.
 * @returns the guarded view; `close` is passed through unchanged.
 */
export function guardStore(store: Store): Store {
  const sessions = store.sessions
  return {
    ensureOwner: guard(store.ensureOwner.bind(store)),
    agents: guardCollection(store.agents),
    templates: guardCollection(store.templates),
    environments: guardCollection(store.environments),
    sessions: {
      insert: guard(sessions.insert.bind(sessions)),
      update: guard(sessions.update.bind(sessions)),
      get: guard(sessions.get.bind(sessions)),
      delete: guard(sessions.delete.bind(sessions)),
      list: guard(sessions.list.bind(sessions)),
      listResumable: guard(sessions.listResumable.bind(sessions)),
      ownersOf: guard(sessions.ownersOf.bind(sessions)),
    },
    audit: guard(store.audit.bind(store)),
    close: () => store.close(),
  }
}

/** Migrating or opening the store failed at plugin start. `/v1` answers 503 `store_unavailable` until the plugin restarts. */
export class StoreStartError extends Error {
  /** @param cause - migration or connection error. */
  constructor(cause: unknown) {
    super(`agents store failed to start: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'StoreStartError'
  }
}
