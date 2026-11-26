/**
 * Pure projection of a DSH Session event sequence onto Agents API wire events,
 * saved items, turns, and session status.
 *
 * One `WireProjector` serves both paths: the live registry applies each
 * `session/event` to its projector, and replay folds the logged events through
 * a fresh one. Wire `id`s, turn ids, item ids, and event ids derive only from
 * the events and the `ProjectionBase`, so both paths number frames the same
 * way and a client's `Last-Event-ID` stays valid across restarts.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { textFromContent, toOAIUsage, parseToolArguments } from '../input.ts'
import { redactAgentSecrets } from '../redact.ts'
import { itemsFromEvent, slashCommandItem, type CommandRun } from '../items.ts'
import { ItemTimer } from './item-timer.ts'
import type {
  OAIAgent,
  OAIAgentSession,
  OAIEnvironmentConfig,
  OAIRequiredAction,
  OAISessionEvent,
  OAISessionItem,
  OAITokenUsage,
  OAITurn,
  SessionStatus,
} from '../types.ts'

/**
 * One SSE frame: the wire event and its position in the session's sequence.
 *
 * Frames of the original event types (session status, turns, assistant
 * messages, slash commands) are numbered 1, 2, 3, ... Item frames added later
 * (user messages, reasoning, tool calls and outputs) are numbered after the
 * frame before them (`12.1`, `12.2`, ...), so adding them never moved the id of
 * an existing frame and a `Last-Event-ID` saved before they existed still
 * resumes at the same place.
 */
export interface ReplayFrame {
  /** 1-based position among the original frames; the SSE `id:` when `sub` is absent. */
  id: number
  /** Position among the item frames that follow frame `id`; the SSE `id:` is then `<id>.<sub>`. */
  sub?: number
  event: OAISessionEvent
}

/** Where a frame sits in a session's sequence; `sub` is 0 for an original frame. */
export interface FramePosition {
  id: number
  sub: number
}

/**
 * @param frame - a frame.
 * @returns its SSE `id:` text, `<id>` or `<id>.<sub>`.
 */
export function frameSseId(frame: Pick<ReplayFrame, 'id' | 'sub'>): string {
  return frame.sub === undefined ? String(frame.id) : `${String(frame.id)}.${String(frame.sub)}`
}

/**
 * Read a `Last-Event-ID`.
 * @param raw - header value, `<id>` or `<id>.<sub>`.
 * @returns the position, or `undefined` when it is not one.
 */
export function parseFrameId(raw: string): FramePosition | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim())
  if (match === null) return undefined
  return { id: Number(match[1]), sub: match[2] === undefined ? 0 : Number(match[2]) }
}

/**
 * @param a - first position.
 * @param b - second position.
 * @returns negative, zero, or positive as `a` is before, at, or after `b`.
 */
export function compareFramePositions(a: FramePosition, b: FramePosition): number {
  return a.id - b.id || a.sub - b.sub
}

/**
 * @param frame - a frame.
 * @returns its position.
 */
export function framePosition(frame: Pick<ReplayFrame, 'id' | 'sub'>): FramePosition {
  return { id: frame.id, sub: frame.sub ?? 0 }
}

/** One saved item, with the child id when it belongs to a subagent. */
export type StoredSessionItem = OAISessionItem & { subagent_id?: string }

/** Session configuration that is not part of the Session log. */
export interface ProjectionBase {
  sessionId: string
  /** Creation time, epoch seconds, from the session index row. */
  createdAt: number
  agent: OAIAgent
  environment: OAIEnvironmentConfig
  metadata: Record<string, string>
  vaultIds: string[]
}

/** Session status after an event, and the error text that goes with it. */
export interface StatusChange {
  status: SessionStatus
  error: string | null
}

/** What one Session event produced. */
export interface WireStep {
  frames: ReplayFrame[]
  /** Set when the event changed the session status. */
  status?: StatusChange
}

/** A wire event before its deterministic `event_id` is assigned. */
type WireEventBody = OAISessionEvent extends infer E ? (E extends unknown ? Omit<E, 'event_id'> : never) : never

/** `turn_id` used for items logged while no turn is open. */
const NO_TURN_ID = 'turn_default'

/** Turn error recorded for a turn closed after a crash. */
const INTERRUPTED_TURN_ERROR = { code: 'interrupted', message: 'Turn interrupted by a server restart' } as const

/**
 * Incremental projector over one session's events.
 *
 * Frame 1 is `agent.session.created`, built from the base; later frames come
 * from `apply`. Unknown event types yield no frames and change nothing, so a
 * newer Host cannot shift later frame ids.
 */
export class WireProjector {
  /** Replaceable when the session settings change; frames already produced keep the old snapshot. */
  base: ProjectionBase
  /** Frame 1, `agent.session.created`. */
  readonly created: ReplayFrame
  readonly turns: OAITurn[] = []
  readonly items: StoredSessionItem[] = []
  status: SessionStatus = 'idle'
  error: string | null = null
  usage: OAITokenUsage | null = null
  lastActiveAt: number
  currentTurnId: string | undefined
  readonly #required: Array<Extract<OAIRequiredAction, { type: 'function_call' }>> = []
  /** Step starts and open tool calls, for item timing. */
  readonly #timer = new ItemTimer()
  /** Pending approvals and questions: live-only, never in the Session log, so a fold of the log never holds any. */
  #interaction: OAIRequiredAction[] = []
  readonly #frames: ReplayFrame[] | undefined
  #nextId = 1
  /** Item frames already numbered after frame `#nextId - 1`. */
  #nextSub = 1
  /** `command/run` records whose `command/done` has not arrived, by command id. */
  readonly #commandRuns = new Map<string, CommandRun>()

  /**
   * @param base - session configuration.
   * @param retainFrames - keep every frame for `frames`; the live path passes `false`.
   */
  constructor(base: ProjectionBase, retainFrames: boolean) {
    this.base = base
    this.lastActiveAt = base.createdAt
    this.#frames = retainFrames ? [] : undefined
    this.created = this.#emit([], { type: 'agent.session.created', session: this.snapshot() })
  }

  /** Every frame so far; throws on a projector built without `retainFrames`. */
  get frames(): readonly ReplayFrame[] {
    if (this.#frames === undefined) throw new Error('WireProjector was built without retainFrames')
    return this.#frames
  }

  /** The `id` the next frame receives. */
  get nextId(): number {
    return this.#nextId
  }

  /** Current wire session resource. */
  snapshot(): OAIAgentSession {
    return {
      id: this.base.sessionId,
      object: 'agent.session',
      created_at: this.base.createdAt,
      last_active_at: this.lastActiveAt,
      status: this.status,
      error: this.error,
      metadata: this.base.metadata,
      vault_ids: this.base.vaultIds,
      agent: redactAgentSecrets(this.base.agent),
      environment: this.base.environment,
      required_actions: [...this.#required, ...this.#interaction],
      usage: this.usage,
    }
  }

  /**
   * Replace the pending approvals and questions shown next to the parked
   * function calls, and recompute the status. Nothing is emitted: the caller
   * decides which ephemeral frame to send.
   * @param actions - all pending `approval` actions.
   * @returns the new status when it changed, else `undefined`.
   */
  setInteractionActions(actions: readonly OAIRequiredAction[]): StatusChange | undefined {
    this.#interaction = [...actions]
    const before = this.status
    if (this.#required.length + this.#interaction.length > 0) {
      if (this.currentTurnId !== undefined) this.status = 'requires_action'
    } else if (this.status === 'requires_action' && this.currentTurnId !== undefined) {
      this.status = 'in_progress'
    }
    return this.status === before ? undefined : { status: this.status, error: this.error }
  }

  /** Names of the agent's wire function tools, which park for a client result. */
  #functionToolNames(): Set<string> {
    const names = new Set<string>()
    for (const tool of this.base.agent.tools) {
      if (tool.type === 'function') names.add(tool.name)
    }
    return names
  }

  /**
   * Project one committed Session event.
   * @param event - next event of the session log, in order.
   * @returns the frames it produced and the status change, if any.
   */
  apply(event: SessionEvent): WireStep {
    const frames: ReplayFrame[] = []
    const at = Math.floor(event.time / 1000)

    if (event.type === 'turn/start') {
      const turn = this.#openTurn(event, at)
      this.status = 'in_progress'
      this.error = null
      this.lastActiveAt = at
      this.#emit(frames, { type: 'agent.session.in_progress', session: this.snapshot() })
      this.#emit(frames, { type: 'agent.session.turn.created', session_id: this.base.sessionId, turn: { ...turn } })
      this.#emit(frames, { type: 'agent.session.turn.in_progress', session_id: this.base.sessionId, turn: { ...turn } })
      return { frames, status: { status: 'in_progress', error: null } }
    }

    if (event.type === 'command/run') {
      const data = event.data
      this.#commandRuns.set(data.commandId, { seq: event.seq, commandId: data.commandId, name: data.name, ...(data.args === undefined ? {} : { args: data.args }) })
      return { frames }
    }
    if (event.type === 'command/done') return this.#commandDone(event, at, frames)

    if (this.#timer.note(event)) return { frames }

    const turnId = this.currentTurnId ?? NO_TURN_ID
    const projected = itemsFromEvent(event, turnId, this.#timer.context(event))
    this.#timer.settle(event, projected)
    const known = projected.length > 0 || event.type === 'turn/end' || event.type === 'assistant/message'
    if (!known) return { frames }
    this.items.push(...projected)
    this.lastActiveAt = at
    this.#itemFrames(event, projected, turnId, frames)

    if (event.type === 'assistant/message') {
      this.#assistantFrames(event, turnId, frames)
      return { frames }
    }

    if (event.type === 'tool/call') return this.#toolCall(projected, turnId, frames)

    if (event.type === 'tool/result') {
      const output = projected.find(item => item.type === 'function_call_output')
      const index = output === undefined ? -1 : this.#required.findIndex(action => action.call_id === output.call_id)
      if (index === -1) return { frames }
      this.#required.splice(index, 1)
      if (this.#required.length === 0 && this.#interaction.length === 0 && this.currentTurnId !== undefined && this.status === 'requires_action') {
        this.status = 'in_progress'
        return { frames, status: { status: 'in_progress', error: this.error } }
      }
      return { frames }
    }

    if (event.type === 'turn/end') return this.#turnEnd(event, at, frames)
    return { frames }
  }

  /** Settle a command: one `slash_command` item and one `agent.session.item.done` frame. */
  #commandDone(event: SessionEvent<'command/done'>, at: number, frames: ReplayFrame[]): WireStep {
    const data = event.data
    const run = this.#commandRuns.get(data.commandId)
    if (run === undefined) return { frames }
    this.#commandRuns.delete(data.commandId)
    const item = slashCommandItem(run, data, this.currentTurnId ?? null)
    this.items.push(item)
    this.lastActiveAt = at
    this.#emit(frames, { type: 'agent.session.item.done', session_id: this.base.sessionId, turn_id: item.turn_id, item })
    return { frames }
  }

  /**
   * Item frames for the items an event saved, other than the assistant
   * message (its own frames follow): a user message, reasoning, or a tool
   * output is `turn.item.done`; a tool call, which waits for its output, is
   * `turn.item.added`. Each frame carries a copy, so later timing updates to
   * the saved item never change a frame already produced.
   */
  #itemFrames(event: SessionEvent, projected: readonly OAISessionItem[], turnId: string, frames: ReplayFrame[]): void {
    for (const item of projected) {
      if (event.type === 'assistant/message' && item.type === 'message') continue
      const type = item.type === 'function_call' || item.type === 'command_execution'
        ? 'agent.session.turn.item.added'
        : 'agent.session.turn.item.done'
      this.#emit(frames, { type, session_id: this.base.sessionId, turn_id: item.turn_id ?? turnId, item: { ...item } }, true)
    }
  }

  /**
   * Number `wire`, record it, and append it to `frames`.
   * @param item - an item frame, numbered after the frame before it (`<id>.<sub>`).
   */
  #emit(frames: ReplayFrame[], wire: WireEventBody, item = false): ReplayFrame {
    let frame: ReplayFrame
    if (item) {
      const id = this.#nextId - 1
      const sub = this.#nextSub
      frame = { id, sub, event: { ...wire, event_id: eventId(this.base.sessionId, `${String(id)}.${String(sub)}`) } as OAISessionEvent }
      this.#nextSub += 1
    } else {
      frame = { id: this.#nextId, event: { ...wire, event_id: eventId(this.base.sessionId, String(this.#nextId)) } as OAISessionEvent }
      this.#nextId += 1
      this.#nextSub = 1
    }
    this.#frames?.push(frame)
    frames.push(frame)
    return frame
  }

  #openTurn(event: SessionEvent, at: number): OAITurn {
    const turn: OAITurn = {
      id: `turn_${String(event.seq)}`,
      object: 'agent.session.turn',
      session_id: this.base.sessionId,
      agent_id: this.base.agent.id,
      status: 'in_progress',
      created_at: at,
      started_at: at,
      completed_at: null,
      subagent_id: null,
      error: null,
      usage: null,
    }
    this.turns.push(turn)
    this.currentTurnId = turn.id
    return turn
  }

  #toolCall(
    projected: readonly OAISessionItem[],
    turnId: string,
    frames: ReplayFrame[],
  ): WireStep {
    const call = projected.find(item => item.type === 'function_call')
    if (call?.type !== 'function_call' || !this.#functionToolNames().has(call.name)) return { frames }
    this.#required.push({
      type: 'function_call',
      name: call.name,
      arguments: typeof call.arguments === 'string' ? parseToolArguments(call.arguments) : call.arguments,
      turn_id: turnId,
      call_id: call.call_id,
    })
    this.status = 'requires_action'
    this.#emit(frames, { type: 'agent.session.requires_action', session: this.snapshot() })
    return { frames, status: { status: 'requires_action', error: this.error } }
  }

  #turnEnd(
    event: SessionEvent,
    at: number,
    frames: ReplayFrame[],
  ): WireStep {
    const data = event.data as {
      usage?: TokenUsage
      reason?: { kind: string; error?: { message?: string; code?: string } }
    }
    const usage = toOAIUsage(data.usage)
    const kind = data.reason?.kind
    const turn = this.turns.find(row => row.id === this.currentTurnId)
    this.#required.length = 0
    this.#interaction = []
    if (turn !== undefined) {
      turn.completed_at = at
      if (usage !== null) {
        turn.usage = usage
        this.usage = usage
      }
      if (kind === 'error') {
        turn.status = 'failed'
        turn.error = { code: data.reason?.error?.code ?? 'UNKNOWN', message: data.reason?.error?.message ?? 'turn failed' }
        this.error = turn.error.message
      } else if (kind === 'aborted' || kind === 'interrupted' || kind === 'forked') {
        turn.status = 'cancelled'
        if (kind === 'interrupted') turn.error = { ...INTERRUPTED_TURN_ERROR }
      } else {
        turn.status = 'completed'
      }
      const type = turn.status === 'failed'
        ? 'agent.session.turn.failed'
        : turn.status === 'cancelled' ? 'agent.session.turn.cancelled' : 'agent.session.turn.completed'
      this.#emit(frames, {
        type,
        session_id: this.base.sessionId,
        turn_id: turn.id,
        turn: { ...turn },
        ...(turn.usage ? { usage: turn.usage } : {}),
      })
    }
    this.currentTurnId = undefined
    this.status = turn?.status === 'failed' ? 'failed' : 'idle'
    this.#emit(frames, { type: 'agent.session.idle', session: this.snapshot() })
    return { frames, status: { status: this.status, error: this.error } }
  }

  #assistantFrames(
    event: SessionEvent,
    turnId: string,
    frames: ReplayFrame[],
  ): void {
    const data = event.data as {
      message?: { content?: unknown }
      stream?: Array<{ type: string; texts?: string[] }>
    }
    const sessionId = this.base.sessionId
    const itemId = `item_msg_${String(event.seq)}`
    this.#emit(frames, {
      type: 'agent.session.turn.item.added',
      session_id: sessionId,
      turn_id: turnId,
      item: { id: itemId, type: 'message', role: 'assistant', content: [], status: 'in_progress', turn_id: turnId },
    })
    const delta = (text: string): void => {
      this.#emit(frames, {
        type: 'agent.session.turn.output_text.delta',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        session_id: sessionId,
        turn_id: turnId,
        delta: text,
      })
    }
    let fullText = ''
    for (const rec of data.stream ?? []) {
      if (rec.type === 'text-chunks' && Array.isArray(rec.texts)) {
        for (const chunk of rec.texts) {
          fullText += chunk
          delta(chunk)
        }
      }
    }
    if (!fullText) {
      fullText = textFromContent(data.message?.content)
      if (fullText) delta(fullText)
    }
    this.#emit(frames, {
      type: 'agent.session.turn.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      session_id: sessionId,
      turn_id: turnId,
      text: fullText,
    })
    this.#emit(frames, {
      type: 'agent.session.turn.item.done',
      session_id: sessionId,
      turn_id: turnId,
      item: {
        id: itemId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: fullText }],
        status: 'completed',
        turn_id: turnId,
      },
    })
  }
}

/**
 * Deterministic wire event id.
 * @param sessionId - session id.
 * @param frameId - the frame's SSE id, `<n>` or `<n>.<sub>`.
 * @returns `evt_<session>_<frameId>`.
 */
function eventId(sessionId: string, frameId: string): string {
  return `evt_${sessionId}_${frameId}`
}

/**
 * Fold a complete event list through a fresh projector.
 * @param base - session configuration.
 * @param events - the session's events, in log order.
 * @returns the projector after the last event, holding every frame.
 */
export function foldSession(base: ProjectionBase, events: readonly SessionEvent[]): WireProjector {
  const projector = new WireProjector(base, true)
  for (const event of events) projector.apply(event)
  return projector
}
