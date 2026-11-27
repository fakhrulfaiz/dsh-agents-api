/**
 * Pure projection of a subagent (Host child session) log onto its turns and
 * items. One `ChildProjector` serves both paths: the live registry applies each
 * committed child event, and `SessionHistory` folds the child's Session log
 * after a restart. Turn ids (`turn_<seq>`), item ids, and times derive only
 * from the events, so both paths return the same turns and items.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { toOAIUsage } from '../input.ts'
import { itemsFromEvent } from '../items.ts'
import { ItemTimer } from './item-timer.ts'
import type { StoredSessionItem } from './projector.ts'
import type { OAITurn } from '../types.ts'

/** `turn_id` used for items logged while no turn is open. */
const NO_TURN_ID = 'turn_default'

/** What one child event changed. */
export interface ChildStep {
  /** The turn the event opened or closed (a copy). */
  turn?: OAITurn
  /** Items the event saved. */
  items: StoredSessionItem[]
}

/** Incremental projector over one child's own (not inherited) events. */
export class ChildProjector {
  readonly turns: OAITurn[] = []
  readonly items: StoredSessionItem[] = []
  currentTurnId: string | undefined
  /** Model of the child's latest request (`request/header`), when one was logged. */
  model: string | undefined
  /** Time of the last applied event, epoch seconds. */
  lastAt: number | undefined
  readonly #timer = new ItemTimer()

  /**
   * @param parentId - Agents API session that owns the child; item image links use it.
   * @param childId - Host child session id.
   * @param agentId - the parent's agent id, shown on child turns.
   */
  constructor(readonly parentId: string, readonly childId: string, readonly agentId: string) {}

  /**
   * Project one committed child event.
   * @param event - next event of the child's log, in order.
   * @returns the turn change and the saved items.
   */
  apply(event: SessionEvent): ChildStep {
    const at = Math.floor(event.time / 1000)
    this.lastAt = at
    if (event.type === 'request/header') {
      const model = (event.data as { header?: { config?: { model?: unknown } } }).header?.config?.model
      if (typeof model === 'string' && model !== '') this.model = model
      return { items: [] }
    }
    if (event.type === 'turn/start') {
      const turn: OAITurn = {
        id: `turn_${String(event.seq)}`,
        object: 'agent.session.turn',
        session_id: this.childId,
        agent_id: this.agentId,
        status: 'in_progress',
        created_at: at,
        started_at: at,
        completed_at: null,
        subagent_id: this.childId,
        error: null,
        usage: null,
      }
      this.turns.push(turn)
      this.currentTurnId = turn.id
      return { turn: { ...turn }, items: [] }
    }
    if (this.#timer.note(event)) return { items: [] }
    const turnId = this.currentTurnId ?? NO_TURN_ID
    const items: StoredSessionItem[] = itemsFromEvent(event, turnId, { ...this.#timer.context(event), sessionId: this.parentId })
      .map(item => ({ ...item, subagent_id: this.childId }))
    this.#timer.settle(event, items)
    this.items.push(...items)
    if (event.type !== 'turn/end') return { items }
    const turn = this.turns.find(row => row.id === this.currentTurnId)
    this.currentTurnId = undefined
    if (turn === undefined) return { items }
    const data = event.data as { usage?: TokenUsage; reason?: { kind: string; error?: { message?: string; code?: string } } }
    const kind = data.reason?.kind
    turn.completed_at = at
    const usage = toOAIUsage(data.usage)
    if (usage !== null) turn.usage = usage
    if (kind === 'error') {
      turn.status = 'failed'
      turn.error = { code: data.reason?.error?.code ?? 'UNKNOWN', message: data.reason?.error?.message ?? 'turn failed' }
    } else if (kind === 'aborted' || kind === 'interrupted' || kind === 'forked') {
      turn.status = 'cancelled'
      if (kind === 'interrupted') turn.error = { code: 'interrupted', message: 'Turn interrupted by a server restart' }
    } else {
      turn.status = 'completed'
    }
    return { turn: { ...turn }, items }
  }
}

/**
 * Fold a child's own events through a fresh projector.
 * @param parentId - owning Agents API session id.
 * @param childId - child session id.
 * @param agentId - the parent's agent id.
 * @param events - the child's events after its inherited prefix, in log order.
 * @returns the projector after the last event.
 */
export function foldChild(parentId: string, childId: string, agentId: string, events: readonly SessionEvent[]): ChildProjector {
  const projector = new ChildProjector(parentId, childId, agentId)
  for (const event of events) projector.apply(event)
  return projector
}
