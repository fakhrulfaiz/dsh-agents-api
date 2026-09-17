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
  items: OAISessionItem[]
  currentTurnId?: string
}

/** Live session directory plus SSE fan-out. */
export class SessionRegistry {
  private readonly sessions = new Map<string, RegisteredSessionState>()
  private readonly subscribers = new Map<string, Set<(event: OAISessionEvent) => void>>()

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
    return this.sessions.delete(id)
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
  appendItems(sessionId: string, items: readonly OAISessionItem[]): void {
    const s = this.sessions.get(sessionId)
    if (!s || items.length === 0) return
    s.items.push(...items)
    s.last_active_at = Math.floor(Date.now() / 1000)
  }

  /**
   * List saved items with cursor pagination. Default order is oldest-first.
   * @param sessionId - session id.
   * @param opts - limit, after, order.
   * @returns one page of items.
   */
  listItems(sessionId: string, opts: ListQuery): OAIListResponse<OAISessionItem> {
    const s = this.sessions.get(sessionId)
    const query = { ...opts, order: opts.order ?? 'asc' }
    return paginate(s ? s.items : [], query)
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
  subscribe(sessionId: string, listener: (event: OAISessionEvent) => void): () => void {
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
   * Fan an event out to current subscribers. Listener throws are ignored so one
   * disconnected client cannot drop the rest.
   * @param sessionId - session id.
   * @param event - output event.
   */
  emit(sessionId: string, event: OAISessionEvent): void {
    const set = this.subscribers.get(sessionId)
    if (!set) return
    for (const listener of set) {
      try {
        listener(event)
      } catch {
        // The client write failed; remaining subscribers must still receive the event.
      }
    }
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
