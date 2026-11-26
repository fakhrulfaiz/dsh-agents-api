/**
 * Live Agents API sessions: one `WireProjector` per session, SSE fan-out, and
 * in-memory subagent state.
 *
 * Items, turns, and session status are not kept here; the projector derives
 * them from the Session log, and `SessionHistory` re-derives them after a
 * restart.
 */

import { randomUUID } from 'node:crypto'
import { mintEventId } from './bridge.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applySessionUpdate } from './session-resource.ts'
import { frameSseId, type StatusChange, type StoredSessionItem, type WireProjector, type WireStep } from './history/projector.ts'
import { ItemTimer } from './history/item-timer.ts'
import type {
  OAIAgentSession,
  OAIRequiredAction,
  OAISessionEvent,
  OAISubagent,
  OAITurn,
  SessionConfig,
  UpdateSessionParams,
} from './types.ts'

export type { ReplayFrame, StoredSessionItem } from './history/projector.ts'

/** One Host child observed because its session header says `origin: subagent`. */
export interface SubagentState {
  id: string
  object: 'agent.session.subagent'
  session_id: string
  parent_session_id: string
  status: 'active' | 'closed'
  created_at: number
  closed_at?: number
  turns: OAITurn[]
  items: StoredSessionItem[]
  currentTurnId?: string
}

/** Live state of one session. */
export interface RegisteredSessionState {
  id: string
  projector: WireProjector
  /** Absolute cwd used for workspace artifact reads. */
  workspace?: string
}

/**
 * Receives each wire frame of a session. `sseId` is the frame's SSE `id`
 * (`<n>` or `<n>.<sub>`), or `undefined` for an ephemeral event, which replay
 * never returns.
 */
export type SessionListener = (event: OAISessionEvent, sseId: string | undefined) => void

/**
 * Wire shape for a subagent. Turns and items stay on their own routes.
 * @param child - stored child.
 * @returns the `agent.session.subagent` resource.
 */
export function subagentResource(child: SubagentState): OAISubagent {
  return {
    id: child.id,
    object: child.object,
    session_id: child.session_id,
    parent_session_id: child.parent_session_id,
    status: child.status,
    created_at: child.created_at,
    ...(child.closed_at !== undefined ? { closed_at: child.closed_at } : {}),
  }
}

/** Live session directory plus SSE fan-out. */
export class SessionRegistry {
  private readonly sessions = new Map<string, RegisteredSessionState>()
  private readonly subscribers = new Map<string, Set<SessionListener>>()
  private readonly subagents = new Map<string, SubagentState>()
  /** Item timers of live children, by the same key as `subagents`. */
  readonly #childTimers = new Map<string, ItemTimer>()

  /**
   * Track a session.
   * @param projector - projector holding the session's wire state; for a resumed session, already folded over the log.
   * @param workspace - absolute cwd used for artifact reads.
   * @returns the live state.
   */
  register(projector: WireProjector, workspace?: string): RegisteredSessionState {
    const state: RegisteredSessionState = {
      id: projector.base.sessionId,
      projector,
      ...(workspace === undefined ? {} : { workspace }),
    }
    this.sessions.set(state.id, state)
    return state
  }

  /**
   * Look up live state.
   * @param id - session id.
   * @returns the state, or `undefined` when the session is not live here.
   */
  get(id: string): RegisteredSessionState | undefined {
    return this.sessions.get(id)
  }

  /**
   * Wire resource of a live session.
   * @param id - session id.
   * @returns the resource, or `undefined` when the session is not live here.
   */
  getOAISession(id: string): OAIAgentSession | undefined {
    return this.sessions.get(id)?.projector.snapshot()
  }

  /**
   * Replace the configuration the live projection shows after a settings update.
   * @param id - session id.
   * @param config - new setup.
   * @returns the updated resource, or `undefined` when the session is not live here.
   */
  applyConfig(id: string, config: SessionConfig): OAIAgentSession | undefined {
    const projector = this.sessions.get(id)?.projector
    if (!projector) return undefined
    projector.base = {
      ...projector.base,
      agent: config.agent,
      environment: config.environment,
      metadata: config.metadata,
      vaultIds: config.vault_ids,
    }
    return projector.snapshot()
  }

  /**
   * Apply a settings update to a live session.
   * @param id - session id.
   * @param params - update body.
   * @returns the updated resource, or `undefined` when the session is not live here or `agent.model` is empty.
   */
  updateSession(id: string, params: UpdateSessionParams): OAIAgentSession | undefined {
    const base = this.sessions.get(id)?.projector.base
    if (!base) return undefined
    const config = applySessionUpdate(
      { agent: base.agent, environment: base.environment, metadata: base.metadata, vault_ids: base.vaultIds },
      params,
    )
    return config === undefined ? undefined : this.applyConfig(id, config)
  }

  /**
   * Drop a session and its subscribers.
   * @param id - session id.
   * @returns whether the session existed.
   */
  delete(id: string): boolean {
    this.subscribers.delete(id)
    for (const key of [...this.subagents.keys()]) {
      if (key.startsWith(`${id}\0`)) {
        this.subagents.delete(key)
        this.#childTimers.delete(key)
      }
    }
    return this.sessions.delete(id)
  }

  /**
   * Remember the cwd used for artifact reads.
   * @param id - session id.
   * @param workspace - absolute directory.
   */
  noteWorkspace(id: string, workspace: string): void {
    const state = this.sessions.get(id)
    if (state) state.workspace = workspace
  }

  /**
   * Id of the open turn.
   * @param sessionId - session id.
   * @returns the turn id, or `undefined` when no turn is open or the session is not live.
   */
  getCurrentTurnId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.projector.currentTurnId
  }

  /**
   * Project one Session event and fan its frames out. Frame ids are the
   * projector's, so they equal the ids a fold of the log assigns.
   * @param sessionId - session id.
   * @param event - committed Session event.
   * @returns the projection step, or `undefined` when the session is not live here.
   */
  apply(sessionId: string, event: SessionEvent): WireStep | undefined {
    const projector = this.sessions.get(sessionId)?.projector
    if (!projector) return undefined
    const step = projector.apply(event)
    for (const frame of step.frames) this.fanOut(sessionId, frame.event, frameSseId(frame))
    return step
  }

  /**
   * Fan out an event that is not a Session log fact (a dispatch error, a
   * connect-time status snapshot). It has no `id`, is not replayed, and does not
   * move later ids.
   * @param sessionId - session id.
   * @param event - wire event.
   */
  emitEphemeral(sessionId: string, event: OAISessionEvent): void {
    this.fanOut(sessionId, event, undefined)
  }

  /**
   * Show the pending approvals and questions of a live session and tell its
   * subscribers. The frame is ephemeral (`agent.session.requires_action` while
   * anything is pending, `agent.session.in_progress` when the last one cleared),
   * so replay and later frame ids are unaffected.
   * @param sessionId - session id.
   * @param actions - all pending `approval` actions.
   * @returns the status change, or `undefined` when the status stayed or the session is not live here.
   */
  setInteractionActions(sessionId: string, actions: readonly OAIRequiredAction[]): StatusChange | undefined {
    const projector = this.sessions.get(sessionId)?.projector
    if (!projector) return undefined
    const change = projector.setInteractionActions(actions)
    if (projector.status === 'requires_action') {
      this.emitEphemeral(sessionId, { type: 'agent.session.requires_action', event_id: mintEventId(), session: projector.snapshot() })
    } else if (change !== undefined) {
      this.emitEphemeral(sessionId, { type: 'agent.session.in_progress', event_id: mintEventId(), session: projector.snapshot() })
    }
    return change
  }

  /**
   * Subscribe to the session's output event stream.
   * @param sessionId - session id.
   * @param listener - callback for each frame.
   * @returns disposer that removes the listener.
   */
  subscribe(sessionId: string, listener: SessionListener): () => void {
    let set = this.subscribers.get(sessionId)
    if (!set) {
      set = new Set()
      this.subscribers.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.subscribers.delete(sessionId)
    }
  }

  /** Listener throws are ignored so one disconnected client cannot drop the rest. */
  private fanOut(sessionId: string, event: OAISessionEvent, sseId: string | undefined): void {
    const set = this.subscribers.get(sessionId)
    if (!set) return
    for (const listener of set) {
      try {
        listener(event, sseId)
      } catch {
        // The client write failed; remaining subscribers must still receive the event.
      }
    }
  }

  /**
   * Register a child session under an Agents API parent.
   * @param parentId - parent Agents API session id.
   * @param childId - Host child session id.
   * @returns the child record.
   */
  ensureSubagent(parentId: string, childId: string): SubagentState | undefined {
    if (!this.sessions.has(parentId)) return undefined
    const key = `${parentId}\0${childId}`
    const existing = this.subagents.get(key)
    if (existing) return existing
    const child: SubagentState = {
      id: childId,
      object: 'agent.session.subagent',
      session_id: childId,
      parent_session_id: parentId,
      status: 'active',
      created_at: Math.floor(Date.now() / 1000),
      turns: [],
      items: [],
    }
    this.subagents.set(key, child)
    this.emitEphemeral(parentId, { type: 'agent.session.subagent.created', event_id: mintEventId(), session_id: parentId, subagent: subagentResource(child) })
    return child
  }

  /**
   * Mark a child closed.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  closeSubagent(parentId: string, childId: string): void {
    const child = this.subagents.get(`${parentId}\0${childId}`)
    if (!child || child.status === 'closed') return
    child.status = 'closed'
    child.closed_at = Math.floor(Date.now() / 1000)
    this.emitEphemeral(parentId, { type: 'agent.session.subagent.closed', event_id: mintEventId(), session_id: parentId, subagent: subagentResource(child) })
  }

  /**
   * List children of a parent session.
   * @param parentId - parent session id.
   */
  listSubagents(parentId: string): SubagentState[] {
    return [...this.subagents.values()].filter(child => child.parent_session_id === parentId)
  }

  /**
   * Look up one child.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  getSubagent(parentId: string, childId: string): SubagentState | undefined {
    return this.subagents.get(`${parentId}\0${childId}`)
  }

  /**
   * Open an in-progress turn that belongs only to the child.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  openChildTurn(parentId: string, childId: string): OAITurn | undefined {
    const child = this.ensureSubagent(parentId, childId)
    const parent = this.sessions.get(parentId)
    if (!child || !parent) return undefined
    const now = Math.floor(Date.now() / 1000)
    const turn: OAITurn = {
      id: `turn_${randomUUID().replaceAll('-', '')}`,
      object: 'agent.session.turn',
      session_id: childId,
      agent_id: parent.projector.base.agent.id,
      status: 'in_progress',
      created_at: now,
      started_at: now,
      completed_at: null,
      subagent_id: childId,
      error: null,
      usage: null,
    }
    child.turns.push(turn)
    child.currentTurnId = turn.id
    this.#childUpdated(parentId, child, turn)
    return turn
  }

  /** Tell the parent's subscribers that a child turn opened or ended. */
  #childUpdated(parentId: string, child: SubagentState, turn: OAITurn): void {
    this.emitEphemeral(parentId, { type: 'agent.session.subagent.updated', event_id: mintEventId(), session_id: parentId, subagent: subagentResource(child), turn: { ...turn } })
  }

  /**
   * Return the child's open turn.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  getCurrentChildTurn(parentId: string, childId: string): OAITurn | undefined {
    const child = this.subagents.get(`${parentId}\0${childId}`)
    if (!child?.currentTurnId) return undefined
    return child.turns.find(turn => turn.id === child.currentTurnId)
  }

  /**
   * Finish the child's open turn.
   * @param parentId - parent session id.
   * @param childId - child session id.
   * @param turnId - turn id.
   * @param status - terminal status.
   * @param error - failure identity when status is failed.
   */
  finishChildTurn(
    parentId: string,
    childId: string,
    turnId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: { code: string; message: string },
  ): OAITurn | undefined {
    const child = this.subagents.get(`${parentId}\0${childId}`)
    const turn = child?.turns.find(row => row.id === turnId)
    if (!child || !turn) return undefined
    const now = Math.floor(Date.now() / 1000)
    turn.status = status
    turn.completed_at = now
    if (error) turn.error = error
    if (child.currentTurnId === turnId) delete child.currentTurnId
    this.#childUpdated(parentId, child, turn)
    return turn
  }

  /**
   * Append items that belong to a child. They stay off the parent item list.
   * @param parentId - parent session id.
   * @param childId - child session id.
   * @param items - projected items.
   */
  appendChildItems(parentId: string, childId: string, items: readonly StoredSessionItem[]): void {
    const child = this.ensureSubagent(parentId, childId)
    if (!child || items.length === 0) return
    const stored = items.map(item => ({ ...item, subagent_id: childId }))
    child.items.push(...stored)
    for (const item of stored) {
      // A tool call waits for its output; everything else is final when saved.
      const type = item.type === 'function_call' || item.type === 'command_execution'
        ? 'agent.session.subagent.item.added'
        : 'agent.session.subagent.item.done'
      this.emitEphemeral(parentId, {
        type,
        event_id: mintEventId(),
        session_id: parentId,
        subagent_id: childId,
        turn_id: item.turn_id ?? child.currentTurnId ?? 'turn_default',
        item: { ...item },
      })
    }
  }

  /**
   * List a child's turns.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  listChildTurns(parentId: string, childId: string): OAITurn[] | undefined {
    return this.subagents.get(`${parentId}\0${childId}`)?.turns
  }

  /**
   * Read one child turn.
   * @param parentId - parent session id.
   * @param childId - child session id.
   * @param turnId - turn id.
   */
  getChildTurn(parentId: string, childId: string, turnId: string): OAITurn | undefined {
    return this.listChildTurns(parentId, childId)?.find(turn => turn.id === turnId)
  }

  /**
   * List a child's items.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  /**
   * The child's item timer (step starts and open tool calls), made on first use.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  childTimer(parentId: string, childId: string): ItemTimer {
    const key = `${parentId}\0${childId}`
    let timer = this.#childTimers.get(key)
    if (!timer) {
      timer = new ItemTimer()
      this.#childTimers.set(key, timer)
    }
    return timer
  }

  listChildItems(parentId: string, childId: string): StoredSessionItem[] | undefined {
    return this.subagents.get(`${parentId}\0${childId}`)?.items
  }
}
