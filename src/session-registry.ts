/**
 * Live Agents API sessions: one `WireProjector` per session, SSE fan-out, and
 * the live cache of subagent state (one `ChildProjector` per child; a rebuild
 * from the child's Session log returns the same turns and items).
 *
 * Items, turns, and session status are not kept here; the projector derives
 * them from the Session log, and `SessionHistory` re-derives them after a
 * restart.
 */

import { mintEventId } from './bridge.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applySessionUpdate } from './session-resource.ts'
import { frameSseId, type StatusChange, type StoredSessionItem, type WireProjector, type WireStep } from './history/projector.ts'
import { ChildProjector } from './history/child-projector.ts'
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
  /** Projection of the child's own events; `turns` and `items` are its arrays. */
  projector: ChildProjector
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
export function subagentResource(child: Pick<SubagentState, 'id' | 'object' | 'session_id' | 'parent_session_id' | 'status' | 'created_at' | 'closed_at' | 'projector'>): OAISubagent {
  return {
    id: child.id,
    object: child.object,
    session_id: child.session_id,
    parent_session_id: child.parent_session_id,
    status: child.status,
    created_at: child.created_at,
    ...(child.closed_at !== undefined ? { closed_at: child.closed_at } : {}),
    model: child.projector.model ?? null,
  }
}

/** Live session directory plus SSE fan-out. */
export class SessionRegistry {
  private readonly sessions = new Map<string, RegisteredSessionState>()
  private readonly subscribers = new Map<string, Set<SessionListener>>()
  private readonly subagents = new Map<string, SubagentState>()

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
      projectId: config.project_id ?? null,
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
      { agent: base.agent, environment: base.environment, metadata: base.metadata, vault_ids: base.vaultIds, project_id: base.projectId ?? null },
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
      if (key.startsWith(`${id}\0`)) this.subagents.delete(key)
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
   * anything is pending, `agent.session.in_progress` when the last one cleared,
   * or `agent.session.idle` when it cleared while no turn was open),
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
      // `idle` when a subagent's request cleared while this session had no open turn.
      const type = change.status === 'idle' ? 'agent.session.idle' : 'agent.session.in_progress'
      this.emitEphemeral(sessionId, { type, event_id: mintEventId(), session: projector.snapshot() })
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
   * @param createdAtMs - the child header's `createdAt` (epoch ms); now when omitted.
   * @returns the child record, or `undefined` when the parent is not live here.
   */
  ensureSubagent(parentId: string, childId: string, createdAtMs?: number): SubagentState | undefined {
    const parent = this.sessions.get(parentId)
    if (!parent) return undefined
    const key = `${parentId}\0${childId}`
    const existing = this.subagents.get(key)
    if (existing) return existing
    const projector = new ChildProjector(parentId, childId, parent.projector.base.agent.id)
    const child: SubagentState = {
      id: childId,
      object: 'agent.session.subagent',
      session_id: childId,
      parent_session_id: parentId,
      status: 'active',
      created_at: Math.floor((createdAtMs ?? Date.now()) / 1000),
      turns: projector.turns,
      items: projector.items,
      projector,
    }
    this.subagents.set(key, child)
    this.emitEphemeral(parentId, { type: 'agent.session.subagent.created', event_id: mintEventId(), session_id: parentId, subagent: subagentResource(child) })
    return child
  }

  /**
   * Project one committed child event and tell the parent's subscribers:
   * `subagent.updated` when a turn opened or ended, `subagent.item.added`
   * for a tool call (it waits for its output), `subagent.item.done` for any
   * other saved item.
   * @param parentId - parent session id.
   * @param childId - child session id.
   * @param event - committed child Session event.
   * @param createdAtMs - the child header's `createdAt`, used when the child is new.
   */
  applyChildEvent(parentId: string, childId: string, event: SessionEvent, createdAtMs?: number): void {
    const child = this.ensureSubagent(parentId, childId, createdAtMs)
    if (!child) return
    const step = child.projector.apply(event)
    if (step.turn && event.type === 'turn/start') this.#childUpdated(parentId, child, step.turn)
    for (const item of step.items) {
      const type = item.type === 'function_call' || item.type === 'command_execution'
        ? 'agent.session.subagent.item.added'
        : 'agent.session.subagent.item.done'
      this.emitEphemeral(parentId, {
        type,
        event_id: mintEventId(),
        session_id: parentId,
        subagent_id: childId,
        turn_id: item.turn_id ?? 'turn_default',
        item: { ...item, subagent_id: childId },
      })
    }
    if (step.turn && event.type === 'turn/end') this.#childUpdated(parentId, child, step.turn)
  }

  /**
   * Mark a child closed. `closed_at` is its last event's time, as a rebuild from the log shows it.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  closeSubagent(parentId: string, childId: string): void {
    const child = this.subagents.get(`${parentId}\0${childId}`)
    if (!child || child.status === 'closed') return
    child.status = 'closed'
    child.closed_at = child.projector.lastAt ?? Math.floor(Date.now() / 1000)
    this.emitEphemeral(parentId, { type: 'agent.session.subagent.closed', event_id: mintEventId(), session_id: parentId, subagent: subagentResource(child) })
  }

  /**
   * List the children of a parent session seen live by this process.
   * @param parentId - parent session id.
   */
  listSubagents(parentId: string): SubagentState[] {
    return [...this.subagents.values()].filter(child => child.parent_session_id === parentId)
  }

  /**
   * Look up one child seen live by this process.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  getSubagent(parentId: string, childId: string): SubagentState | undefined {
    return this.subagents.get(`${parentId}\0${childId}`)
  }

  /** Tell the parent's subscribers that a child turn opened or ended. */
  #childUpdated(parentId: string, child: SubagentState, turn: OAITurn): void {
    this.emitEphemeral(parentId, { type: 'agent.session.subagent.updated', event_id: mintEventId(), session_id: parentId, subagent: subagentResource(child), turn })
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
   * List a child's items.
   * @param parentId - parent session id.
   * @param childId - child session id.
   */
  listChildItems(parentId: string, childId: string): StoredSessionItem[] | undefined {
    return this.subagents.get(`${parentId}\0${childId}`)?.items
  }
}
