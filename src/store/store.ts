/**
 * Durable Agentry records: owners, saved agents, environment templates,
 * environments, projects, the session index, and the admin audit log.
 *
 * Every owner-scoped read and write takes the caller's `OwnerId`; a record of
 * another owner reads as absent. Items, turns, and steps are not stored here:
 * the DSH Session log is their source of truth.
 */

import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { OwnerId } from '../auth/authenticator.ts'
import type { EnvironmentRecord, EnvironmentTemplate } from '../environment-types.ts'
import type { ListQuery } from '../http.ts'
import type { OAIAgent, OAIListResponse, OAIProject, ProjectListQuery, SessionConfig, SessionStatus } from '../types.ts'

/** One row of the session index. Model-visible history stays in the DSH Session log. */
export interface SessionIndexRow {
  id: string
  ownerId: OwnerId
  agentId: string | null
  environmentId: string | null
  /** Project this chat belongs to; `null` means unfiled. */
  projectId: string | null
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

/** Owner-scoped projects. `list` has its own status filter and cursor query; the rest matches `OwnedCollection`. */
export interface ProjectCollection extends Omit<OwnedCollection<OAIProject>, 'list'> {
  /**
   * @param q - owner, status filter, limit, `after` id, and order.
   * @returns one page of the owner's projects, newest first unless `order` is `asc`.
   */
  list(q: ProjectListQuery): Promise<OAIListResponse<OAIProject>>
  /**
   * @param owner - calling principal.
   * @param id - project id.
   * @returns how many of the owner's sessions belong to the project; `0` when missing or foreign.
   */
  countSessions(owner: OwnerId, id: string): Promise<number>
}

/**
 * Session index filters. Rows are ordered by `createdAt`, then `id`, newest
 * first. `from` is inclusive and `to` exclusive; `cursor` is the `nextCursor`
 * of the previous page.
 */
export interface SessionListQuery {
  owner: OwnerId | 'any'
  agentId?: string
  /** `null` keeps only unfiled sessions; `undefined` keeps every session. */
  projectId?: string | null
  status?: string
  from?: Date
  to?: Date
  /** Keep only sessions whose metadata has every one of these keys with these values. */
  metadata?: Record<string, string>
  cursor?: string
  limit: number
}

/** DSH attachment reference stored on an attached file, as JSON. */
export type FileAttachmentSnapshot =
  /** A normalized raster stored with `saveImage`. */
  | { kind: 'image'; ref: ImageAttachmentRef }
  /** Verbatim bytes stored with `saveFileStream`. */
  | { kind: 'file'; ref: FileAttachmentRef }

/** One uploaded file. `staged` bytes live in the staging `FileStore`; `attached` bytes live in the DSH attachment store. */
export interface FileRow {
  /** `file_<random>`. */
  id: string
  ownerId: OwnerId
  /** Sanitized leaf name; never a path. */
  name: string
  /** Server-decided media type (magic bytes for rasters, extension allow-list otherwise). */
  mediaType: string
  /** Exact byte length of the upload. */
  bytes: number
  /** Hex sha256 of the uploaded bytes. */
  sha256: string
  status: 'staged' | 'attached'
  /** Session the file was attached to; `null` while staged. */
  sessionId: string | null
  /** DSH reference after attach; `null` while staged. */
  attachment: FileAttachmentSnapshot | null
  /** Path of the workspace copy relative to the session workspace (`uploads/<name>`); `null` while staged. */
  workspacePath: string | null
  createdAt: Date
  attachedAt: Date | null
}

/** What `files.markAttached` records once the DSH object and the workspace copy exist. */
export interface FileAttachedPatch {
  attachment: FileAttachmentSnapshot
  workspacePath: string
}

/** Uploaded-file records. Every method is owner-scoped except the sweep helpers. */
export interface FileCollection {
  /**
   * @param row - new `staged` row; its owner must exist and `id` must be new.
   */
  insert(row: FileRow): Promise<void>
  /**
   * @param id - file id.
   * @param owner - calling principal.
   * @returns the row, or `undefined` when missing or owned by someone else.
   */
  get(id: string, owner: OwnerId): Promise<FileRow | undefined>
  /**
   * @param owner - calling principal.
   * @param ids - file ids.
   * @returns the rows of `owner` among `ids`, in no particular order; unknown and foreign ids are absent.
   */
  getMany(owner: OwnerId, ids: readonly string[]): Promise<FileRow[]>
  /**
   * Page of the owner's files, newest first (`created_at`, then `id`).
   * @param owner - calling principal.
   * @param q - `after` is the last id of the previous page (an id the owner does not hold starts from the top); `limit` is the page size; `status` keeps one status.
   * @returns up to `limit` rows and whether more follow.
   */
  list(owner: OwnerId, q: { after?: string; limit: number; status?: FileRow['status'] }): Promise<{ data: FileRow[]; hasMore: boolean }>
  /**
   * Remove a `staged` row.
   * @param id - file id.
   * @param owner - calling principal.
   * @returns the removed row; `'attached'` when the row exists but is attached (nothing removed); `undefined` when missing or foreign.
   */
  deleteStaged(id: string, owner: OwnerId): Promise<FileRow | 'attached' | undefined>
  /**
   * @param owner - calling principal.
   * @returns total bytes of the owner's `staged` rows.
   */
  stagedBytes(owner: OwnerId): Promise<number>
  /**
   * Atomically move `ids` from `staged` to `attached` for `sessionId`. All or none: when any id is
   * missing, foreign, or not `staged` (for example claimed by a concurrent send), nothing changes.
   * @param owner - calling principal.
   * @param ids - distinct file ids.
   * @param sessionId - session the files are attached to.
   * @returns the claimed rows in `ids` order, or `undefined` when the claim failed.
   */
  claim(owner: OwnerId, ids: readonly string[], sessionId: string): Promise<FileRow[] | undefined>
  /**
   * Record the DSH object and workspace copy of a claimed row.
   * @param id - file id.
   * @param owner - calling principal.
   * @param patch - attachment reference and workspace path.
   */
  markAttached(id: string, owner: OwnerId, patch: FileAttachedPatch): Promise<void>
  /**
   * Return claimed rows to `staged` and clear their attach fields, after a send failed before the message was queued.
   * @param owner - calling principal.
   * @param ids - file ids; rows that are not `attached` are left alone.
   */
  release(owner: OwnerId, ids: readonly string[]): Promise<void>
  /**
   * @param owner - calling principal.
   * @param sessionId - session id.
   * @returns the owner's `attached` rows of the session that carry a DSH reference.
   */
  listForSession(owner: OwnerId, sessionId: string): Promise<FileRow[]>
  /**
   * Remove the rows of a removed session. DSH objects are content-addressed and stay.
   * @param owner - calling principal.
   * @param sessionId - session id.
   * @returns how many rows were removed.
   */
  deleteForSession(owner: OwnerId, sessionId: string): Promise<number>
  /**
   * Remove `staged` rows created before `before`, for every owner.
   * @param before - cutoff.
   * @returns the removed rows, so the caller can remove their bytes.
   */
  expireStaged(before: Date): Promise<FileRow[]>
  /**
   * @param ids - file ids, any owner.
   * @returns the subset that exists as `staged` rows.
   */
  stagedIds(ids: readonly string[]): Promise<Set<string>>
}

/** Agentry's durable storage. Rejections mean the backing database failed, except `InvalidCursorError`. */
/** Where an installed skill applies: the owner's library, or one saved agent. */
export type SkillScope = 'library' | 'agent'
/** How a skill was installed. */
export type SkillSource = 'upload' | 'github' | 'editor' | 'chat'
/** GitHub provenance of an imported skill. */
export interface SkillOrigin {
  repo: string
  path: string
  ref: string
  /** Resolved commit sha the files came from. */
  commit: string
}

/** One installed skill; its files live on disk under the plugin's `skills.dir`. */
export interface SkillRow {
  /** `skill_` plus 32 hex characters. */
  id: string
  owner: OwnerId
  scope: SkillScope
  /** Saved agent id when `scope` is `agent`; otherwise null. */
  agent_id: string | null
  name: string
  description: string
  source: SkillSource
  origin: SkillOrigin | null
  content_hash: string
  has_scripts: boolean
  status: 'pending_review' | 'active'
  /** Epoch seconds. */
  created_at: number
  /** Epoch seconds. */
  updated_at: number
}

/** A second skill with the same (owner, name). */
export class SkillNameTakenError extends Error {
  constructor(name: string) {
    super(`a skill named "${name}" already exists`)
    this.name = 'SkillNameTakenError'
  }
}

/** Installed skills, owner-scoped. */
export interface SkillCollection {
  /** @throws SkillNameTakenError when the owner already has a skill with that name. */
  insert(row: SkillRow): Promise<void>
  get(id: string, owner: OwnerId): Promise<SkillRow | undefined>
  /** @returns the owner's rows matching every given filter, oldest first. */
  list(owner: OwnerId, filter?: { scope?: SkillScope; agentId?: string; status?: SkillRow['status'] }): Promise<SkillRow[]>
  /** @returns the updated row, or `undefined` when missing or foreign. */
  update(id: string, owner: OwnerId, patch: Partial<Pick<SkillRow, 'description' | 'content_hash' | 'has_scripts' | 'status' | 'origin' | 'updated_at'>>): Promise<SkillRow | undefined>
  /** @returns the removed row, or `undefined` when missing or foreign. */
  delete(id: string, owner: OwnerId): Promise<SkillRow | undefined>
  /** Remove every owner's `pending_review` rows last updated before `cutoff` (epoch seconds). */
  deleteStagedBefore(cutoff: number): Promise<SkillRow[]>
}

export interface Store {
  /**
   * Record an owner. Idempotent.
   * @param owner - authenticated owner id.
   */
  ensureOwner(owner: OwnerId): Promise<void>
  agents: OwnedCollection<OAIAgent>
  templates: OwnedCollection<EnvironmentTemplate>
  environments: OwnedCollection<EnvironmentRecord>
  projects: ProjectCollection
  files: FileCollection
  skills: SkillCollection
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
     * Merge keys into the session's stored metadata in one atomic step, so two
     * concurrent merges cannot drop each other's keys.
     * @param id - session id.
     * @param owner - calling principal, or `'any'`.
     * @param patch - keys to set; a `null` value deletes the key.
     * @returns the updated row, or `undefined` when missing, owned by someone else, or without a stored setup.
     */
    mergeMetadata(id: string, owner: OwnerId | 'any', patch: Record<string, string | null>): Promise<SessionIndexRow | undefined>
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
      if (error instanceof InvalidCursorError || error instanceof StoreUnavailableError || error instanceof SkillNameTakenError) throw error
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
 * Guard every method of the project collection.
 * @param projects - project collection.
 * @returns the same collection with outage rejections normalized.
 */
function guardProjects(projects: ProjectCollection): ProjectCollection {
  return {
    create: guard(projects.create.bind(projects)),
    get: guard(projects.get.bind(projects)),
    update: guard(projects.update.bind(projects)),
    delete: guard(projects.delete.bind(projects)),
    list: guard(projects.list.bind(projects)),
    countSessions: guard(projects.countSessions.bind(projects)),
  }
}

/**
 * Guard every method of the file collection.
 * @param files - file collection.
 * @returns the same collection with outage rejections normalized.
 */
function guardFiles(files: FileCollection): FileCollection {
  return {
    insert: guard(files.insert.bind(files)),
    get: guard(files.get.bind(files)),
    getMany: guard(files.getMany.bind(files)),
    deleteStaged: guard(files.deleteStaged.bind(files)),
    stagedBytes: guard(files.stagedBytes.bind(files)),
    claim: guard(files.claim.bind(files)),
    markAttached: guard(files.markAttached.bind(files)),
    release: guard(files.release.bind(files)),
    listForSession: guard(files.listForSession.bind(files)),
    list: guard(files.list.bind(files)),
    deleteForSession: guard(files.deleteForSession.bind(files)),
    expireStaged: guard(files.expireStaged.bind(files)),
    stagedIds: guard(files.stagedIds.bind(files)),
  }
}

/**
 * Guard every method of the skill collection; `SkillNameTakenError` passes through.
 * @param skills - skill collection.
 * @returns the same collection with outage rejections normalized.
 */
function guardSkills(skills: SkillCollection): SkillCollection {
  return {
    insert: guard(skills.insert.bind(skills)),
    get: guard(skills.get.bind(skills)),
    list: guard(skills.list.bind(skills)),
    update: guard(skills.update.bind(skills)),
    delete: guard(skills.delete.bind(skills)),
    deleteStagedBefore: guard(skills.deleteStagedBefore.bind(skills)),
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
    projects: guardProjects(store.projects),
    sessions: {
      insert: guard(sessions.insert.bind(sessions)),
      update: guard(sessions.update.bind(sessions)),
      mergeMetadata: guard(sessions.mergeMetadata.bind(sessions)),
      get: guard(sessions.get.bind(sessions)),
      delete: guard(sessions.delete.bind(sessions)),
      list: guard(sessions.list.bind(sessions)),
      listResumable: guard(sessions.listResumable.bind(sessions)),
      ownersOf: guard(sessions.ownersOf.bind(sessions)),
    },
    files: guardFiles(store.files),
    skills: guardSkills(store.skills),
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
