/**
 * In-memory registry of Agents API sessions, turns, saved items, and SSE fans.
 */

import { randomUUID } from 'node:crypto'
import { paginate, type ListQuery } from './http.ts'
import type {
  OAIAgent,
  OAIAgentSession,
  OAIEnvironmentConfig,
  OAIListResponse,
  OAIRequiredAction,
  OAISessionEvent,
  OAISessionItem,
  OAITokenUsage,
  OAITurn,
  SessionStatus,
  UpdateSessionParams,
} from './types.ts'

/** How many SSE events to keep for `Last-Event-ID` replay. */
const REPLAY_LIMIT = 200

/** One saved item, with the child id when it belongs to a subagent. */
export type StoredSessionItem = OAISessionItem & { subagent_id?: string }

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

/** One buffered SSE frame. */
export interface ReplayFrame {
  id: number
  event: OAISessionEvent
}

/** Mutable per-session state owned by the gateway. */
export interface RegisteredSessionState {
  id: string
  created_at: number
  last_active_at: number
  status: SessionStatus
  error: string | null
  metadata: Record<string, string>
  vault_ids: string[]
  agent: OAIAgent
  environment: OAIEnvironmentConfig
  required_actions: OAIRequiredAction[]
  usage: OAITokenUsage | null
  turns: OAITurn[]
  items: StoredSessionItem[]
  currentTurnId?: string
  /** Absolute cwd used for workspace artifact reads. */
  workspace?: string
}

/** Live session directory plus SSE fan-out. */
export class SessionRegistry {
  private readonly sessions = new Map<string, RegisteredSessionState>()
  private readonly subscribers = new Map<string, Set<(event: OAISessionEvent, sseId: number) => void>>()
  private readonly replay = new Map<string, ReplayFrame[]>()
  private readonly nextEventId = new Map<string, number>()
  private readonly subagents = new Map<string, SubagentState>()

  /**
   * Record a new session.
   * @param id - session id shared with the Host Agent.
   * @param agent - session-local agent configuration.
   * @param environment - create-session environment.
   * @param metadata - string map copied onto the resource.
   * @param vaultIds - vault ids copied onto the resource.
   * @returns the stored state.
   */
  register(
    id: string,
    agent: OAIAgent,
    environment: OAIEnvironmentConfig = { type: 'none' },
    metadata: Record<string, string> = {},
    vaultIds: string[] = [],
  ): RegisteredSessionState {
    const now = Math.floor(Date.now() / 1000)
    const state: RegisteredSessionState = {
      id,
      created_at: now,
      last_active_at: now,
      status: 'idle',
      error: null,
      metadata,
      vault_ids: vaultIds,
      agent,
      environment,
      required_actions: [],
      usage: null,
      turns: [],
      items: [],
    }
    this.sessions.set(id, state)
    return state
  }

  /**
   * Look up mutable session state.
   * @param id - session id.
   * @returns the state, or `undefined` when missing.
   */
  get(id: string): RegisteredSessionState | undefined {
    return this.sessions.get(id)
  }

  /**
   * Project mutable state onto the wire session resource.
   * @param s - stored session state.
   * @returns the Agents API session object.
   */
  project(s: RegisteredSessionState): OAIAgentSession {
    return {
      id: s.id,
      object: 'agent.session',
      created_at: s.created_at,
      last_active_at: s.last_active_at,
      status: s.status,
      error: s.error,
      metadata: s.metadata,
      vault_ids: s.vault_ids,
      agent: s.agent,
      environment: s.environment,
      required_actions: s.required_actions,
      usage: s.usage,
    }
  }

  /**
   * Project a session resource.
   * @param id - session id.
   * @returns the wire resource, or `undefined` when missing.
   */
  getOAISession(id: string): OAIAgentSession | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return this.project(s)
  }

  /**
   * Apply a session-settings update. Only `model`, `reasoning.effort`,
   * `service_tier`, and `metadata` change; `metadata: null` clears the map.
   * @param id - session id.
   * @param params - update body.
   * @returns the updated resource, or `undefined` when missing.
   */
  updateSession(id: string, params: UpdateSessionParams): OAIAgentSession | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (params.metadata !== undefined) {
      s.metadata = params.metadata ?? {}
    }
    const patch = params.agent
    if (patch) {
      if (patch.model !== undefined) {
        if (patch.model === '' || patch.model === null) return undefined
        s.agent = { ...s.agent, model: patch.model, updated_at: Math.floor(Date.now() / 1000) }
      }
      if (patch.service_tier !== undefined) {
        s.agent = {
          ...s.agent,
          updated_at: Math.floor(Date.now() / 1000),
          ...(patch.service_tier === null ? { service_tier: null } : { service_tier: patch.service_tier }),
        }
      }
      if (patch.reasoning !== undefined) {
        const effort = patch.reasoning.effort
        const existing = s.agent.reasoning ?? {}
        s.agent = {
          ...s.agent,
          updated_at: Math.floor(Date.now() / 1000),
          reasoning: {
            ...existing,
            ...(effort === undefined ? {} : { effort }),
          },
        }
      }
    }
    s.last_active_at = Math.floor(Date.now() / 1000)
    return this.getOAISession(id)
  }

  /**
   * Drop a session and its subscribers.
   * @param id - session id.
   * @returns whether the session existed.
   */
  delete(id: string): boolean {
    this.subscribers.delete(id)
    this.replay.delete(id)
    this.nextEventId.delete(id)
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
   * Record a new in-progress turn.
   * @param sessionId - session id.
   * @returns the turn, or `undefined` when the session is missing.
   */
  createTurn(sessionId: string): OAITurn | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    return this.openTurn(s)
  }

  /**
   * Open a new in-progress turn on already-loaded session state.
   * @param s - stored session state.
   * @returns the new turn.
   */
  openTurn(s: RegisteredSessionState): OAITurn {
    const now = Math.floor(Date.now() / 1000)
    const turn: OAITurn = {
      id: `turn_${randomUUID().replaceAll('-', '')}`,
      object: 'agent.session.turn',
      session_id: s.id,
      agent_id: s.agent.id,
      status: 'in_progress',
      created_at: now,
      started_at: now,
      completed_at: null,
      subagent_id: null,
      error: null,
      usage: null,
    }
    s.turns.push(turn)
    s.currentTurnId = turn.id
    s.status = 'in_progress'
    s.last_active_at = now
    return turn
  }

  /**
   * Return the open turn, if any.
   * @param sessionId - session id.
   * @returns the current turn.
   */
  getCurrentTurn(sessionId: string): OAITurn | undefined {
    const s = this.sessions.get(sessionId)
    if (!s?.currentTurnId) return undefined
    return s.turns.find(t => t.id === s.currentTurnId)
  }

  /**
   * Mark a turn completed and return the session to idle.
   * @param sessionId - session id.
   * @param turnId - turn id.
   * @param usage - recorded usage, when known.
   * @returns the completed turn.
   */
  completeTurn(sessionId: string, turnId: string, usage?: OAITokenUsage | null): OAITurn | undefined {
    return this.finishTurn(sessionId, turnId, 'completed', usage)
  }

  /**
   * Mark a turn failed.
   * @param sessionId - session id.
   * @param turnId - turn id.
   * @param error - failure identity.
   * @returns the failed turn.
   */
  failTurn(sessionId: string, turnId: string, error: { code: string; message: string }): OAITurn | undefined {
    return this.finishTurn(sessionId, turnId, 'failed', null, error)
  }

  /**
   * Mark a turn cancelled and return the session to idle.
   * @param sessionId - session id.
   * @param turnId - turn id.
   * @returns the cancelled turn.
   */
  cancelTurn(sessionId: string, turnId: string): OAITurn | undefined {
    return this.finishTurn(sessionId, turnId, 'cancelled')
  }

  /**
   * List turns with cursor pagination.
   * @param sessionId - session id.
   * @param opts - limit, after, order.
   * @returns one page of turns.
   */
  listTurns(sessionId: string, opts: ListQuery): OAIListResponse<OAITurn> {
    const s = this.sessions.get(sessionId)
    return paginate(s ? s.turns : [], opts, turn => turn.created_at)
  }

  /**
   * Retrieve one turn.
   * @param sessionId - session id.
   * @param turnId - turn id.
   * @returns the turn, or `undefined` when missing.
   */
  getTurn(sessionId: string, turnId: string): OAITurn | undefined {
    const s = this.sessions.get(sessionId)
    return s?.turns.find(t => t.id === turnId)
  }

  /**
   * Append projected items from a live Session event.
   * @param sessionId - session id.
   * @param items - items to store.
   */
  appendItems(sessionId: string, items: readonly StoredSessionItem[]): void {
    const s = this.sessions.get(sessionId)
    if (!s || items.length === 0) return
    const parentItems = items.filter(item => typeof item.subagent_id !== 'string' || item.subagent_id === '')
    if (parentItems.length === 0) return
    s.items.push(...parentItems)
    s.last_active_at = Math.floor(Date.now() / 1000)
  }

  /**
   * List saved items with cursor pagination. Default order is oldest-first.
   * @param sessionId - session id.
   * @param opts - limit, after, order.
   * @returns one page of items.
   */
  listItems(sessionId: string, opts: ListQuery): OAIListResponse<StoredSessionItem> {
    const s = this.sessions.get(sessionId)
    const query = { ...opts, order: opts.order ?? 'asc' }
    const items = (s ? s.items : []).filter(item => typeof item.subagent_id !== 'string' || item.subagent_id === '')
    return paginate(items, query)
  }

  /**
   * List sessions with cursor pagination.
   * @param opts - limit, after, order.
   * @returns one page of sessions.
   */
  list(opts: ListQuery): OAIListResponse<OAIAgentSession> {
    const all = [...this.sessions.keys()]
      .map(id => this.getOAISession(id))
      .filter((session): session is OAIAgentSession => session !== undefined)
    return paginate(all, opts, session => session.created_at)
  }

  /**
   * Subscribe to the session's output event stream.
   * @param sessionId - session id.
   * @param listener - callback for each event.
   * @returns disposer that removes the listener.
   */
  subscribe(sessionId: string, listener: (event: OAISessionEvent, sseId: number) => void): () => void {
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

  /**
   * Record an event, then fan it out. The numeric id is the SSE `id:` field.
   * Listener throws are ignored so one disconnected client cannot drop the rest.
   * @param sessionId - session id.
   * @param event - output event.
   * @returns the SSE id assigned to this event.
   */
  emit(sessionId: string, event: OAISessionEvent): number {
    const id = (this.nextEventId.get(sessionId) ?? 0) + 1
    this.nextEventId.set(sessionId, id)
    const frames = this.replay.get(sessionId) ?? []
    frames.push({ id, event })
    if (frames.length > REPLAY_LIMIT) frames.splice(0, frames.length - REPLAY_LIMIT)
    this.replay.set(sessionId, frames)
    const set = this.subscribers.get(sessionId)
    if (!set) return id
    for (const listener of set) {
      try {
        listener(event, id)
      } catch {
        // The client write failed; remaining subscribers must still receive the event.
      }
    }
    return id
  }

  /**
   * Return buffered events newer than `Last-Event-ID`.
   * @param sessionId - session id.
   * @param lastId - last id the client already has; `0` replays the buffer.
   */
  replayAfter(sessionId: string, lastId: number): ReplayFrame[] {
    return (this.replay.get(sessionId) ?? []).filter(frame => frame.id > lastId)
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
      agent_id: parent.agent.id,
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
    return turn
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
    child.items.push(...items.map(item => ({ ...item, subagent_id: childId })))
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
  listChildItems(parentId: string, childId: string): StoredSessionItem[] | undefined {
    return this.subagents.get(`${parentId}\0${childId}`)?.items
  }

  /**
   * Replace `required_actions` and derive session status for parked function calls.
   *
   * When actions are non-empty the session is `requires_action`. When they clear
   * while a turn is still open the session returns to `in_progress`; otherwise
   * idle/failed are left unchanged.
   *
   * @param sessionId - session id.
   * @param actions - pending function (or other) required actions.
   * @returns the projected session, or `undefined` when missing.
   */
  syncRequiredActions(sessionId: string, actions: readonly OAIRequiredAction[]): OAIAgentSession | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    s.required_actions = [...actions]
    s.last_active_at = Math.floor(Date.now() / 1000)
    if (actions.length > 0) {
      s.status = 'requires_action'
    } else if (s.currentTurnId !== undefined && s.status === 'requires_action') {
      s.status = 'in_progress'
    }
    return this.project(s)
  }

  private finishTurn(
    sessionId: string,
    turnId: string,
    status: 'completed' | 'failed' | 'cancelled',
    usage?: OAITokenUsage | null,
    error?: { code: string; message: string },
  ): OAITurn | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const turn = s.turns.find(t => t.id === turnId)
    if (!turn) return undefined
    const now = Math.floor(Date.now() / 1000)
    turn.status = status
    turn.completed_at = now
    if (usage) {
      turn.usage = usage
      s.usage = usage
    }
    if (error) {
      turn.error = error
      s.error = error.message
    }
    if (s.currentTurnId === turnId) {
      delete s.currentTurnId
      s.status = status === 'failed' ? 'failed' : 'idle'
    }
    s.last_active_at = now
    return turn
  }
}
