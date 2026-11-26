/**
 * Items, turns, and wire events of a session, derived from its DSH Session log.
 *
 * Every call reads the log through `sessionQuery.readSession` (live sessions
 * from memory, others from persistence) and folds it through `WireProjector`.
 * Nothing is cached, so a read always reflects the log.
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { paginate, type ListQuery } from '../http.ts'
import type { OAIListResponse, OAITurn } from '../types.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { toolResultImageRefs } from '../files/tool-images.ts'
import { deliverablesFromEvents, type DeliverableEntry } from './deliverables.ts'
import { compareFramePositions, foldSession, framePosition, type FramePosition, type ProjectionBase, type ReplayFrame, type StoredSessionItem, type WireProjector } from './projector.ts'

/** Reads a session's history from the Session log. */
export interface SessionHistory {
  /**
   * Saved items in log order (oldest first unless `q.order` is `desc`).
   * @param base - session configuration.
   * @param q - limit, `after`, and order.
   * @returns one page of items.
   */
  items(base: ProjectionBase, q: ListQuery): Promise<OAIListResponse<StoredSessionItem>>
  /**
   * Turns in log order, newest first unless `q.order` is `asc`. Ordering follows the log, not second-resolution timestamps.
   * @param base - session configuration.
   * @param q - limit, `after`, and order.
   * @returns one page of turns.
   */
  turns(base: ProjectionBase, q: ListQuery): Promise<OAIListResponse<OAITurn>>
  /**
   * @param base - session configuration.
   * @param turnId - turn id.
   * @returns the turn, or `undefined` when the log has no such turn.
   */
  turn(base: ProjectionBase, turnId: string): Promise<OAITurn | undefined>
  /**
   * @param base - session configuration.
   * @param after - last frame the caller has (a frame `id`, or a position for an item frame); `0` returns every frame.
   * @returns frames after it, in order.
   */
  wireEvents(base: ProjectionBase, after: number | FramePosition): Promise<ReplayFrame[]>
  /**
   * Fold the whole log into a fresh projector that the caller owns, for example to seed a live session.
   * @param base - session configuration.
   * @returns a projector positioned after the last logged event.
   */
  fold(base: ProjectionBase): Promise<WireProjector>
  /**
   * @param sessionId - session id.
   * @returns files declared with `present`, oldest first; empty when the log is missing.
   */
  deliverables(sessionId: string): Promise<DeliverableEntry[]>
  /**
   * @param sessionId - session id (a subagent's Host session id works too).
   * @returns the image references in its tool results, oldest first; empty when the log is missing.
   */
  toolImages(sessionId: string): Promise<ImageAttachmentRef[]>
  /**
   * @param sessionId - session id.
   * @returns the working directory in the session header, or `undefined` when the log is missing.
   */
  workspace(sessionId: string): Promise<string | undefined>
}

/**
 * @param sessionQuery - session-query service; only `readSession` is used.
 * @returns the history reader.
 */
export function createSessionHistory(sessionQuery: Pick<SessionQueryEngine, 'readSession'>): SessionHistory {
  /**
   * A session that has not logged an event yet may have no readable log; that
   * is an empty history, not an error.
   */
  async function read(sessionId: string) {
    try {
      return await sessionQuery.readSession(SessionId(sessionId))
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
      throw error
    }
  }

  const fold = async (base: ProjectionBase): Promise<WireProjector> =>
    foldSession(base, (await read(base.sessionId))?.events ?? [])

  return {
    fold,
    async items(base, q) {
      return paginate((await fold(base)).items, { ...q, order: q.order ?? 'asc' })
    },
    async turns(base, q) {
      return paginate((await fold(base)).turns, q)
    },
    async turn(base, turnId) {
      return (await fold(base)).turns.find(turn => turn.id === turnId)
    },
    async wireEvents(base, after) {
      const last = typeof after === 'number' ? { id: after, sub: 0 } : after
      return (await fold(base)).frames.filter(frame => compareFramePositions(framePosition(frame), last) > 0)
    },
    async deliverables(sessionId) {
      return deliverablesFromEvents((await read(sessionId))?.events ?? [])
    },
    async toolImages(sessionId) {
      const refs: ImageAttachmentRef[] = []
      for (const event of (await read(sessionId))?.events ?? []) {
        if (event.type !== 'tool/result') continue
        refs.push(...toolResultImageRefs((event.data as { message?: { content?: unknown } }).message?.content))
      }
      return refs
    },
    async workspace(sessionId) {
      const cwd = (await read(sessionId))?.session.cwd
      return cwd === undefined ? undefined : String(cwd)
    },
  }
}
