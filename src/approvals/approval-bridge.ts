/**
 * Bridge from DSH approval and user-question requests to the Agents API
 * `approval` required action.
 *
 * DSH seams (pinned `dsh-v0.2.2-rc.1`; both are Cordis waterfalls, there is no
 * registration call):
 * - `approval/request`: `(req: ApprovalRequestEvent, next) => Promise<ApprovalOutcome>`
 *   with `ApprovalRequestEvent { agent; toolName; callId?; reason?; displayReason?; signal? }`
 *   and `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
 *   (`dsh-user-approval/types`). `ApprovalService.request` appends
 *   `approval/asked { id, toolName, callId?, reason? }` before the waterfall
 *   runs and `approval/decided` after it settles; the `id` is the wire id here.
 * - `user-questions/request`: `(req: AskUserQuestionRequestEvent, next) => Promise<AskUserQuestionAnswer>`
 *   with `AskUserQuestionRequestEvent { questions; agent?; signal?; wait?: { callId; timed? } }`
 *   and `AskUserQuestionAnswer { answers: { id; selected: string[]; custom? }[] }`
 *   (`dsh-user-questions/types`). Empty `selected` without `custom` means skipped.
 *
 * The listeners run first (`prepend`): the DSH web remote bridge, mounted
 * earlier, otherwise holds every request while a DSH web tab is connected and
 * the Agents API client never sees it. They claim only requests whose agent is
 * a registered Agents API session, or a subagent (header `origin: subagent`)
 * of one, and call `next()` for everything else, so the DSH web UI keeps
 * answering its own sessions. A subagent's request surfaces on its parent
 * session as an `approval` action marked with `subagent_id`, and the parent's
 * `approval_response` answers it; it stays pending until answered or until the
 * child's own turn ends (the parent's turn ending does not cancel it, because
 * a child can outlive the parent's turn).
 *
 * Questions from a subagent never reach this listener: `UserQuestionService.ask`
 * refuses any agent that is not a live root (`DELEGATED_CALLER`) before the
 * waterfall runs, timed (`askTimed`) or not, and tells the child to put the
 * question in its final result. Timed questions of a root session
 * (`wait.timed`) need a client claim over RPC (`attachWait`); they are not
 * claimed. Pending requests live in memory only: after a restart DSH repair
 * closes the turn, so no approval is pending and an old id is not found.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { AgentsApiRequestError } from '../errors.ts'
import type { OAIRequiredAction } from '../types.ts'

/** Decisions a client may post for an `approval` action. */
export type ApprovalDecision = 'approve' | 'deny' | 'answer'

/** The `approval` variant of {@link OAIRequiredAction}. */
export type ApprovalAction = Extract<OAIRequiredAction, { type: 'approval' }>

/** Pending approvals and questions of the sessions this API owns. */
export interface ApprovalBridge {
  /**
   * Required actions currently waiting for a client answer.
   * @param sessionId - Agents API session id.
   * @returns the pending `approval` actions, oldest first.
   */
  pending(sessionId: string): ApprovalAction[]
  /**
   * Resolve one pending request.
   * @param sessionId - Agents API session id.
   * @param approvalId - `id` of the `approval` action.
   * @param decision - `approve`/`deny` for an approval; `answer` or `deny` (skip) for a question.
   * @param payload - for `answer`: `{ selected, custom? }` for one question, else `{ answers: [...] }`.
   * @returns `resolved`, or `not_found` when the id is unknown, already answered, or cancelled.
   * @throws AgentsApiRequestError 400 `decision_not_applicable` when the decision does not fit the request kind, or 400 `invalid_approval_response` when an `answer` payload does not answer every question.
   */
  answer(sessionId: string, approvalId: string, decision: ApprovalDecision, payload?: unknown): 'resolved' | 'not_found'
  /**
   * Settle every pending request of a session as cancelled (approvals resolve
   * `cancelled`, questions reject).
   * @param sessionId - Agents API session id.
   */
  cancelAll(sessionId: string): void
}

/** The Agents API session a request is shown on. */
export interface ClaimedSession {
  /** Agents API session id. */
  sessionId: string
  /** Set when the request came from this subagent (Host child session id) of the session. */
  subagentId?: string
}

/**
 * Which Agents API session owns an agent: its own session when registered,
 * else the registered parent of a subagent.
 * @param agent - agent behind a DSH request.
 * @param isRegistered - whether a session id is a live Agents API session.
 * @returns the claim, or `undefined` to delegate the request.
 */
export function claimAgent(agent: Pick<Agent, 'session'>, isRegistered: (sessionId: string) => boolean): ClaimedSession | undefined {
  const session = agent.session
  if (isRegistered(session.id)) return { sessionId: session.id }
  const parent = session.header?.parentSession
  if (session.header?.origin === 'subagent' && parent !== undefined && isRegistered(parent)) {
    return { sessionId: parent, subagentId: session.id }
  }
  return undefined
}

/** Collaborators supplied by the plugin. */
export interface ApprovalBridgeDeps {
  /**
   * Which Agents API session owns an agent.
   * @param agent - agent behind a DSH request.
   * @returns the claim, or `undefined` to delegate the request.
   */
  claims(agent: Agent): ClaimedSession | undefined
  /**
   * Called after the pending set of a session changed.
   * @param sessionId - Agents API session id.
   * @param actions - all pending `approval` actions of the session.
   */
  onChange(sessionId: string, actions: OAIRequiredAction[]): void
}

/** `source` is the session that asked: the claimed session itself, or its subagent. */
type Entry = { action: ApprovalAction; source: string; detach: () => void } & (
  | { kind: 'approval'; settle: (outcome: ApprovalOutcome) => void }
  | { kind: 'question'; questions: readonly AskUserQuestionItem[]; settle: (answer: AskUserQuestionAnswer) => void; reject: (error: Error) => void }
)

/** `approval/asked` payload remembered until its request reaches the listener. */
interface Asked {
  id: string
  toolName: string
  callId: string | undefined
}

/** Reason prefix written by `approveEscalation` in `dsh-sandbox`; a test pins it against the real function. */
const ESCALATION_REASON_PREFIX = 'escalate sandbox to '

/**
 * Install the answerers and the Session-event hook.
 * @param ctx - plugin context; every listener is registered through `ctx.effect`.
 * @param deps - session ownership and change notification.
 * @returns the bridge.
 */
export function installApprovalBridge(ctx: Context, deps: ApprovalBridgeDeps): ApprovalBridge {
  const pending = new Map<string, Map<string, Entry>>()
  const asked = new Map<string, Asked[]>()

  const actionsOf = (sessionId: string): ApprovalAction[] =>
    [...pending.get(sessionId)?.values() ?? []].map(entry => entry.action)

  const notify = (sessionId: string): void => {
    deps.onChange(sessionId, actionsOf(sessionId))
  }

  const remove = (sessionId: string, id: string): Entry | undefined => {
    const entries = pending.get(sessionId)
    const entry = entries?.get(id)
    if (entry === undefined) return undefined
    entry.detach()
    entries!.delete(id)
    if (entries!.size === 0) pending.delete(sessionId)
    return entry
  }

  const add = (sessionId: string, entry: Entry, signal: AbortSignal | undefined): void => {
    let entries = pending.get(sessionId)
    if (entries === undefined) {
      entries = new Map()
      pending.set(sessionId, entries)
    }
    entries.set(entry.action.id, entry)
    if (signal !== undefined) {
      const onAbort = (): void => {
        const dropped = remove(sessionId, entry.action.id)
        if (dropped === undefined) return
        cancel(dropped)
        notify(sessionId)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const detach = entry.detach
      entry.detach = () => {
        signal.removeEventListener('abort', onAbort)
        detach()
      }
    }
    notify(sessionId)
  }

  /** Cancel every pending request that `source` asked, whichever session shows it. */
  const cancelSource = (source: string): void => {
    for (const [sessionId, entries] of [...pending]) {
      const ids = [...entries.values()].filter(entry => entry.source === source).map(entry => entry.action.id)
      for (const id of ids) {
        const entry = remove(sessionId, id)
        if (entry !== undefined) cancel(entry)
      }
      if (ids.length > 0) notify(sessionId)
    }
  }

  const takeAsked = (source: string, req: ApprovalRequestEvent): string => {
    const queue = asked.get(source) ?? []
    const index = queue.findIndex(row => row.toolName === req.toolName && row.callId === req.callId)
    if (index === -1) return `appr_${randomUUID().replaceAll('-', '')}`
    return queue.splice(index, 1)[0]!.id
  }

  ctx.effect(() => ctx.on('approval/request', (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => {
    const claim = deps.claims(req.agent)
    if (claim === undefined || req.signal?.aborted === true) return next()
    const { sessionId, subagentId } = claim
    const source = req.agent.session.id
    const id = takeAsked(source, req)
    return new Promise<ApprovalOutcome>((resolve) => {
      add(sessionId, {
        kind: 'approval',
        source,
        detach: () => undefined,
        settle: resolve,
        action: {
          type: 'approval',
          id,
          kind: req.reason?.startsWith(ESCALATION_REASON_PREFIX) === true ? 'sandbox_escalation' : 'tool_approval',
          prompt: req.displayReason?.en ?? req.reason ?? `Approve ${req.toolName}`,
          options: ['approve', 'deny'],
          tool_name: req.toolName,
          ...(req.callId === undefined ? {} : { call_id: req.callId }),
          ...(subagentId === undefined ? {} : { subagent_id: subagentId }),
        },
      }, req.signal)
    })
  }, { prepend: true }), 'agents-api: approval answerer')

  ctx.effect(() => ctx.on('user-questions/request', (req: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>) => {
    const claim = req.agent === undefined ? undefined : deps.claims(req.agent)
    if (claim === undefined || req.wait?.timed === true || req.signal?.aborted === true) return next()
    const { sessionId, subagentId } = claim
    const only = req.questions.length === 1 ? req.questions[0] : undefined
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      add(sessionId, {
        kind: 'question',
        source: req.agent!.session.id,
        questions: req.questions,
        detach: () => undefined,
        settle: resolve,
        reject,
        action: {
          type: 'approval',
          id: req.wait?.callId ?? `appr_${randomUUID().replaceAll('-', '')}`,
          kind: 'user_question',
          prompt: req.questions.map(item => item.question).join('\n'),
          options: only?.options?.map(option => option.label) ?? [],
          ...(only === undefined ? { questions: req.questions } : {}),
          ...(subagentId === undefined ? {} : { subagent_id: subagentId }),
        },
      }, req.signal)
    })
  }, { prepend: true }), 'agents-api: user-question answerer')

  ctx.effect(() => ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'approval/asked') {
      const data = event.data
      const queue = asked.get(session.id) ?? []
      queue.push({ id: data.id, toolName: data.toolName, callId: data.callId })
      asked.set(session.id, queue)
    } else if (event.type === 'approval/decided') {
      const queue = asked.get(session.id)
      const index = queue?.findIndex(row => row.id === event.data.id) ?? -1
      if (index !== -1) queue!.splice(index, 1)
    } else if (event.type === 'turn/end') {
      // Approvals are turn-enclosed: whatever this session asked belongs to a finished turn.
      // A subagent's requests shown on this session are its own turn's, so they stay.
      cancelSource(session.id)
    }
  }), 'agents-api: approval ids')

  ctx.effect(() => ctx.on('session/disposed', (session: Session) => {
    asked.delete(session.id)
    bridge.cancelAll(session.id)
    cancelSource(session.id)
  }), 'agents-api: approval cleanup')

  const bridge: ApprovalBridge = {
    pending: actionsOf,
    answer(sessionId, approvalId, decision, payload) {
      const entry = pending.get(sessionId)?.get(approvalId)
      if (entry === undefined) return 'not_found'
      const resolution = resolveEntry(entry, decision, payload)
      remove(sessionId, approvalId)
      resolution()
      notify(sessionId)
      return 'resolved'
    },
    cancelAll(sessionId) {
      const entries = [...pending.get(sessionId)?.keys() ?? []]
      for (const id of entries) {
        const entry = remove(sessionId, id)
        if (entry !== undefined) cancel(entry)
      }
      if (entries.length > 0) notify(sessionId)
    },
  }
  return bridge
}

/** Settle an entry as cancelled. */
function cancel(entry: Entry): void {
  if (entry.kind === 'approval') entry.settle('cancelled')
  else entry.reject(new Error('question cancelled'))
}

/**
 * Validate a decision against the request and return the settle action.
 * @throws AgentsApiRequestError 400 when the decision or payload does not fit the request.
 */
function resolveEntry(entry: Entry, decision: ApprovalDecision, payload: unknown): () => void {
  if (entry.kind === 'approval') {
    if (decision === 'answer') {
      throw new AgentsApiRequestError('"answer" applies to user questions; use "approve" or "deny"', 400, 'decision_not_applicable')
    }
    const outcome: ApprovalOutcome = decision === 'approve' ? 'allowed-once' : 'rejected'
    return () => { entry.settle(outcome) }
  }
  if (decision === 'approve') {
    throw new AgentsApiRequestError('"approve" applies to approvals; use "answer" or "deny" (skip) for a question', 400, 'decision_not_applicable')
  }
  const answer: AskUserQuestionAnswer = decision === 'deny'
    ? { answers: entry.questions.map(item => ({ id: item.id, selected: [] })) }
    : questionAnswer(entry.questions, payload)
  return () => { entry.settle(answer) }
}

/**
 * Build the answer batch from an `answer` payload.
 * @throws AgentsApiRequestError 400 `invalid_approval_response` unless the payload answers each question once.
 */
function questionAnswer(questions: readonly AskUserQuestionItem[], payload: unknown): AskUserQuestionAnswer {
  const invalid = (message: string): AgentsApiRequestError => new AgentsApiRequestError(message, 400, 'invalid_approval_response')
  if (payload === null || typeof payload !== 'object') throw invalid('"answer" needs a payload object')
  const body = payload as Record<string, unknown>
  const only = questions.length === 1 ? questions[0] : undefined
  const rows: unknown = Array.isArray(body['answers'])
    ? body['answers']
    : only !== undefined && Array.isArray(body['selected']) ? [{ id: only.id, ...body }] : undefined
  if (!Array.isArray(rows)) {
    throw invalid(only === undefined ? 'payload needs "answers" with one entry per question' : 'payload needs "selected" or "answers"')
  }
  const answers = rows.map((row: unknown) => {
    const item = row as Record<string, unknown> | null
    const selected = item?.['selected']
    const custom = item?.['custom']
    if (typeof item?.['id'] !== 'string' || !Array.isArray(selected) || selected.some(value => typeof value !== 'string')
      || (custom !== undefined && typeof custom !== 'string')) {
      throw invalid('each answer needs a string "id", a string array "selected", and an optional string "custom"')
    }
    return { id: item['id'], selected: selected as string[], ...(custom === undefined ? {} : { custom }) }
  })
  const expected = questions.map(item => item.id)
  const given = answers.map(item => item.id)
  if (given.length !== expected.length || expected.some(id => !given.includes(id)) || new Set(given).size !== given.length) {
    throw invalid(`answers must cover exactly the question ids: ${expected.join(', ')}`)
  }
  return { answers }
}
