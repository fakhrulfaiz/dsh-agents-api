/**
 * `/v1/agents/schedules`: scheduled tasks over the Host schedule service.
 *
 * The Host service has no owner. A task belongs to the owner of its target
 * session, else of the first involved session that has an index row (see
 * `ownerOf`). Every route that names a task reads it, resolves its owner
 * through the store, and answers 404 for another owner's task before any
 * mutating service method runs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryRecord,
  ScheduleViewRequest,
  SchedulePatch,
  ScheduleRecord,
  ScheduleService,
} from '@deepseek-ai/dsh-schedule'
import type { OwnerId, Principal } from './auth/authenticator.ts'
import { AgentsApiRequestError, SessionCreateError } from './errors.ts'
import type { Route } from './gateway.ts'
import { badRequest, json, listQuery, notFound, readBody, routeParam, writeRequestError } from './http.ts'
import type { Store } from './store/store.ts'
import type {
  AgentSchedule,
  AgentScheduleRun,
  CreateScheduleParams,
  OAIAgentSession,
  ScheduleStatus,
  ScheduleTiming,
  UpdateScheduleParams,
} from './types.ts'

/** What `ScheduleApi` needs from the gateway. */
export interface ScheduleApiDeps {
  /** The Host schedule service, read at call time; `undefined` answers 501 `schedules_unavailable`. */
  schedule: () => ScheduleService | undefined
  /** The attached store; throws `StoreUnavailableError` when none is attached. */
  store: () => Store
  /** Create an idle session for `owner` (`AgentsGateway.createIdleSession`). */
  createSession: (owner: OwnerId, params: CreateScheduleSessionParams) => Promise<OAIAgentSession>
  /** Remove a session without an HTTP request (`AgentsGateway.discardSession`). */
  discardSession: (owner: OwnerId, sessionId: string) => Promise<void>
}

/** Session body the schedule routes pass to `createSession`. */
export type CreateScheduleSessionParams = Pick<CreateScheduleParams, 'agent' | 'agent_id' | 'environment'> & { metadata: Record<string, string> }

/** Timing kinds the Host service accepts. */
const TIMING_KINDS: ReadonlySet<string> = new Set(['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule'])

/** Longest task title the Host service accepts. */
const MAX_TITLE_LENGTH = 120

/** Statuses accepted by the list filter. */
const STATUSES: ReadonlySet<string> = new Set<ScheduleStatus>(['active', 'paused', 'ended'])

/** HTTP status, wire code, and message of a failure raised by the service or the session resolver. */
export interface MappedScheduleError {
  status: number
  code: string
  message: string
}

/**
 * Map a failure from the schedule service, or from resolving the target
 * session, to its wire status and code.
 *
 * `ScheduleInputError` and `RemoteError` are matched by name and marker
 * because the schedule package is an optional peer and may be a different
 * module copy than the one that threw.
 * @param error - caught value.
 * @returns the mapping, or `undefined` for a failure the API does not classify.
 */
export function mapScheduleError(error: unknown): MappedScheduleError | undefined {
  if (error instanceof AgentsApiRequestError) return { status: error.status, code: error.code, message: error.message }
  if (!(error instanceof Error)) return undefined
  const code: unknown = (error as { code?: unknown }).code
  if (error.name === 'ScheduleInputError' && typeof code === 'string') return { status: 400, code, message: error.message }
  if (error.name === 'RemoteError' && (error as { isDSHRemoteError?: unknown }).isDSHRemoteError === true) {
    if (code === 'schedule/input-invalid') {
      const detail = (error as { details?: { code?: unknown } }).details?.code
      return { status: 400, code: typeof detail === 'string' ? detail : 'invalid_rule', message: error.message }
    }
    if (code === 'schedule/target-archived') return { status: 409, code: 'schedule_target_archived', message: error.message }
  }
  return undefined
}

/**
 * Wire form of a stored rule: DSH's tagged union with snake_case selectors.
 * A one-shot echoes its committed UTC instant (`at`) or its delay (`after`).
 * @param record - stored timing record of a catalog entry.
 * @returns the timing as accepted on input.
 */
export function toWireTiming(record: ScheduleRecord): ScheduleTiming {
  switch (record.kind) {
    case 'after': return { kind: 'after', after_seconds: record.afterSeconds }
    case 'at': return { kind: 'at', at: record.scheduledAt }
    case 'every': return { kind: 'every', every_seconds: record.everySeconds }
    case 'daily': return { kind: 'daily', daily: { time: record.time, time_zone: record.timeZone } }
    case 'weekly': return { kind: 'weekly', weekly: { time: record.time, time_zone: record.timeZone, weekdays: [...record.weekdays] } }
    case 'cron': return { kind: 'cron', cron: { expression: record.expression, time_zone: record.timeZone } }
    case 'rrule': return { kind: 'rrule', rrule: record.rrule }
  }
}

/**
 * Session ids that can establish a task's owner, in priority order: the
 * target session, then the involved sessions.
 * @param entry - catalog entry.
 * @returns distinct session ids.
 */
export function candidateSessionIds(entry: ScheduleCatalogEntry): string[] {
  const ids = 'sessionId' in entry.target ? [entry.target.sessionId, ...entry.involvedSessionIds] : [...entry.involvedSessionIds]
  return [...new Set<string>(ids)]
}

/**
 * Owner of a task and the session that receives its runs: the first
 * candidate session that has an index row.
 * @param entry - catalog entry.
 * @param owners - owners by session id from `store.sessions.ownersOf`.
 * @returns the owner and that session id, or `undefined` when no candidate session is indexed.
 */
export function ownerOf(entry: ScheduleCatalogEntry, owners: ReadonlyMap<string, OwnerId>): { owner: OwnerId; sessionId: string } | undefined {
  for (const sessionId of candidateSessionIds(entry)) {
    const owner = owners.get(sessionId)
    if (owner !== undefined) return { owner, sessionId }
  }
  return undefined
}

/**
 * Wire form of a delivery.
 * @param record - saved delivery.
 * @returns the run resource.
 */
function toWireRun(record: { scheduledAt: string; deliveredAt: string; messageId: string; targetSessionId: string }): AgentScheduleRun {
  return { scheduled_at: record.scheduledAt, delivered_at: record.deliveredAt, message_id: record.messageId, session_id: record.targetSessionId }
}

/**
 * Wire form of a catalog entry.
 * @param entry - catalog entry.
 * @param sessionId - session that receives the runs, from `ownerOf`.
 * @returns the schedule resource.
 */
export function toWireSchedule(entry: ScheduleCatalogEntry, sessionId: string): AgentSchedule {
  const createdAt = entry.createdAt ?? entry.updatedAt ?? entry.scheduledAt
  const updatedAt = entry.updatedAt ?? createdAt
  return {
    id: entry.id,
    object: 'agent.schedule',
    title: entry.title,
    prompt: entry.prompt,
    timing: toWireTiming(entry),
    status: entry.status,
    next_run_at: entry.status === 'active' ? entry.scheduledAt : null,
    created_at: createdAt,
    updated_at: updatedAt,
    revision: updatedAt,
    session_id: sessionId,
    running: entry.executionActive === true,
    last_run: entry.lastDelivery === undefined ? null : toWireRun(entry.lastDelivery),
  }
}

/**
 * Write a classified service failure.
 * @param res - outgoing response.
 * @param mapped - status, code, and message.
 */
function writeMapped(res: ServerResponse, mapped: MappedScheduleError): void {
  json(res, mapped.status, { error: { type: mapped.status >= 500 ? 'server_error' : 'invalid_request_error', message: mapped.message, code: mapped.code } })
}

/**
 * Write 404 `schedule_not_found`.
 * @param res - outgoing response.
 * @param id - task id from the route.
 */
function scheduleNotFound(res: ServerResponse, id: string): void {
  json(res, 404, { error: { type: 'invalid_request_error', message: `Schedule "${id}" not found`, code: 'schedule_not_found' } })
}

/**
 * Write a request-level 409.
 * @param res - outgoing response.
 * @param code - wire code.
 * @param message - detail.
 */
function conflict(res: ServerResponse, code: string, message: string): void {
  json(res, 409, { error: { type: 'invalid_request_error', message, code } })
}

/**
 * @param value - parsed JSON value.
 * @returns whether it is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Check that `timing` is an object with a known `kind`. The Host service
 * validates the selector members and values and answers its own codes.
 * @param value - request value.
 * @returns the timing, or `undefined` when it is not an object with a known kind.
 */
function parseTiming(value: unknown): ScheduleTiming | undefined {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || !TIMING_KINDS.has(value['kind'])) return undefined
  return value as ScheduleTiming
}

/**
 * @param value - request value for `title`.
 * @returns the trimmed title, or `undefined` when it is not a string of 1-120 characters after trimming.
 */
function parseTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value.trim()
  return title.length >= 1 && title.length <= MAX_TITLE_LENGTH ? title : undefined
}

/**
 * @param value - request value for `prompt`.
 * @returns the trimmed prompt, or `undefined` when it is not a non-empty string.
 */
function parsePrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const prompt = value.trim()
  return prompt === '' ? undefined : prompt
}

/** Request-time handlers for the schedule routes. */
export class ScheduleApi {
  private readonly deps: ScheduleApiDeps

  /**
   * @param deps - schedule service accessor, store accessor, and session create and discard.
   */
  constructor(deps: ScheduleApiDeps) {
    this.deps = deps
  }

  /**
   * @returns the schedule routes. Register them before `/agents/:agent_id` so `schedules` is never read as an agent id.
   */
  routes(): Route[] {
    return [
      { method: 'POST', pattern: '/agents/schedules', handler: (req, res, _url, _params, p) => this.create(req, res, p) },
      { method: 'GET', pattern: '/agents/schedules', handler: (_req, res, url, _params, p) => this.list(res, url, p) },
      { method: 'GET', pattern: '/agents/schedules/:schedule_id/runs', handler: (_req, res, url, params, p) => this.runs(res, url, params, p) },
      { method: 'POST', pattern: '/agents/schedules/:schedule_id/pause', handler: (_req, res, _url, params, p) => this.setActive(res, params, p, false) },
      { method: 'POST', pattern: '/agents/schedules/:schedule_id/resume', handler: (_req, res, _url, params, p) => this.setActive(res, params, p, true) },
      { method: 'POST', pattern: '/agents/schedules/:schedule_id/run', handler: (_req, res, _url, params, p) => this.run(res, params, p) },
      { method: 'GET', pattern: '/agents/schedules/:schedule_id', handler: (_req, res, _url, params, p) => this.get(res, params, p) },
      { method: 'POST', pattern: '/agents/schedules/:schedule_id', handler: (req, res, _url, params, p) => this.update(req, res, params, p) },
      { method: 'DELETE', pattern: '/agents/schedules/:schedule_id', handler: (_req, res, _url, params, p) => this.remove(res, params, p) },
    ]
  }

  /**
   * Answer 501 when the profile has no schedule service.
   * @param res - outgoing response.
   * @returns the service, or `undefined` after the 501 was written.
   */
  private service(res: ServerResponse): ScheduleService | undefined {
    const service = this.deps.schedule()
    if (service === undefined) {
      json(res, 501, { error: { type: 'server_error', message: 'The scheduled-task service is not available in this profile', code: 'schedules_unavailable' } })
    }
    return service
  }

  /**
   * Read a task and check that `owner` owns it. Only `view` runs before the
   * check; another owner's task and an unknown id both answer 404.
   * @param res - outgoing response; receives the 404.
   * @param service - schedule service.
   * @param owner - calling principal.
   * @param id - task id from the route.
   * @returns the entry and its session, or `undefined` after a 404 was written.
   */
  private async loadOwned(res: ServerResponse, service: ScheduleService, owner: OwnerId, id: string): Promise<{ entry: ScheduleCatalogEntry; sessionId: string } | undefined> {
    const found = await service.view({ id: id as ScheduleViewRequest['id'] })
    if ('code' in found) {
      scheduleNotFound(res, id)
      return undefined
    }
    const owned = ownerOf(found, await this.deps.store().sessions.ownersOf(candidateSessionIds(found)))
    if (owned === undefined || owned.owner !== owner) {
      scheduleNotFound(res, id)
      return undefined
    }
    return { entry: found, sessionId: owned.sessionId }
  }

  /**
   * Run a service call and write its classified failures.
   * @param res - outgoing response.
   * @param call - the service call.
   * @returns the call's result, or `undefined` after an error response was written.
   * @throws the failure when it is not classified by `mapScheduleError`.
   */
  private async guarded<T>(res: ServerResponse, call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call()
    } catch (error: unknown) {
      const mapped = mapScheduleError(error)
      if (mapped === undefined) throw error
      writeMapped(res, mapped)
      return undefined
    }
  }

  private async create(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
    const service = this.service(res)
    if (service === undefined) return
    const body = await readBody(req)
    const title = parseTitle(body['title'])
    if (title === undefined) return badRequest(res, `Field "title" must be a string of 1-${String(MAX_TITLE_LENGTH)} characters`)
    const prompt = parsePrompt(body['prompt'])
    if (prompt === undefined) return badRequest(res, 'Field "prompt" must be a non-empty string')
    const timing = parseTiming(body['timing'])
    if (timing === undefined) return badRequest(res, 'Field "timing" must be an object with a kind of after, at, every, daily, weekly, cron, or rrule')
    const sessionIdField = body['session_id']
    if (sessionIdField !== undefined && typeof sessionIdField !== 'string') return badRequest(res, 'Field "session_id" must be a string')

    const { owner } = principal
    let sessionId: string
    let provisioned = false
    if (sessionIdField !== undefined) {
      if (await this.deps.store().sessions.get(sessionIdField, owner) === undefined) return notFound(res, `Session "${sessionIdField}" not found`)
      sessionId = sessionIdField
    } else {
      try {
        const params: Partial<CreateScheduleParams> = body
        sessionId = (await this.deps.createSession(owner, {
          ...(params.agent === undefined ? {} : { agent: params.agent }),
          ...(params.agent_id === undefined ? {} : { agent_id: params.agent_id }),
          ...(params.environment === undefined ? {} : { environment: params.environment }),
          metadata: { title, source: 'schedule' },
        })).id
        provisioned = true
      } catch (error: unknown) {
        if (error instanceof AgentsApiRequestError) return writeRequestError(res, error)
        if (error instanceof SessionCreateError) {
          return json(res, 500, { error: { type: 'server_error', message: error.message, code: error.code } })
        }
        throw error
      }
    }

    try {
      const entry = await service.create({ title, prompt, timing, target: { kind: 'session', sessionId: SessionId(sessionId) } }, SessionId(sessionId))
      json(res, 200, toWireSchedule(entry, sessionId))
    } catch (error: unknown) {
      if (provisioned) await this.discardQuietly(owner, sessionId)
      const mapped = mapScheduleError(error)
      if (mapped === undefined) throw error
      writeMapped(res, mapped)
    }
  }

  /**
   * Remove the session provisioned for a task whose creation failed. A removal
   * failure must not replace the creation failure the caller reports.
   * @param owner - owner of the session.
   * @param sessionId - provisioned session.
   */
  private async discardQuietly(owner: OwnerId, sessionId: string): Promise<void> {
    try {
      await this.deps.discardSession(owner, sessionId)
    } catch (discardError: unknown) {
      // discardError is dropped: the creation failure is the actionable error, and the leftover idle session stays listed under the owner for manual deletion.
    }
  }

  private async list(res: ServerResponse, url: URL, principal: Principal): Promise<void> {
    const service = this.service(res)
    if (service === undefined) return
    const status = url.searchParams.get('status')
    if (status !== null && !STATUSES.has(status)) return badRequest(res, 'Query "status" must be active, paused, or ended')
    const query = listQuery(url)
    const catalog = await service.catalog()
    const owners = await this.deps.store().sessions.ownersOf([...new Set(catalog.flatMap(candidateSessionIds))])
    const mine: AgentSchedule[] = []
    for (const entry of catalog) {
      const owned = ownerOf(entry, owners)
      if (owned === undefined || owned.owner !== principal.owner) continue
      if (status !== null && entry.status !== status) continue
      mine.push(toWireSchedule(entry, owned.sessionId))
    }
    const start = query.after === undefined ? 0 : mine.findIndex(item => item.id === query.after) + 1
    const data = mine.slice(start, start + query.limit)
    json(res, 200, {
      object: 'list',
      data,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
      has_more: start + data.length < mine.length,
    })
  }

  private async get(res: ServerResponse, params: Record<string, string>, principal: Principal): Promise<void> {
    const service = this.service(res)
    if (service === undefined) return
    const owned = await this.loadOwned(res, service, principal.owner, routeParam(params, 'schedule_id'))
    if (owned !== undefined) json(res, 200, toWireSchedule(owned.entry, owned.sessionId))
  }

  /**
   * Write the outcome of an `edit` update.
   * @param res - outgoing response.
   * @param id - task id.
   * @param sessionId - session of the task.
   * @param result - service result.
   */
  private respondEdit(res: ServerResponse, id: string, sessionId: string, result: Awaited<ReturnType<ScheduleService['edit']>>): void {
    if ('code' in result) {
      if (result.code === 'schedule_conflict') conflict(res, 'schedule_conflict', `Schedule "${id}" changed since revision was read`)
      else scheduleNotFound(res, id)
      return
    }
    if ('deleted' in result) {
      json(res, 200, { id, object: 'agent.schedule.deleted', deleted: true })
      return
    }
    json(res, 200, toWireSchedule(result, sessionId))
  }

  private async update(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: Principal): Promise<void> {
    const service = this.service(res)
    if (service === undefined) return
    const id = routeParam(params, 'schedule_id')
    const body = await readBody(req) as UpdateScheduleParams & Record<string, unknown>
    const patch: { -readonly [K in keyof SchedulePatch]: SchedulePatch[K] } = {}
    if (body.title !== undefined) {
      const title = parseTitle(body.title)
      if (title === undefined) return badRequest(res, `Field "title" must be a string of 1-${String(MAX_TITLE_LENGTH)} characters`)
      patch.title = title
    }
    if (body.prompt !== undefined) {
      const prompt = parsePrompt(body.prompt)
      if (prompt === undefined) return badRequest(res, 'Field "prompt" must be a non-empty string')
      patch.prompt = prompt
    }
    if (body.timing !== undefined) {
      const timing = parseTiming(body.timing)
      if (timing === undefined) return badRequest(res, 'Field "timing" must be an object with a kind of after, at, every, daily, weekly, cron, or rrule')
      patch.timing = timing
    }
    if (body.revision !== undefined && typeof body.revision !== 'string') return badRequest(res, 'Field "revision" must be a string')
    if (Object.keys(patch).length === 0) return badRequest(res, 'Provide at least one of "title", "prompt", or "timing"')
    const owned = await this.loadOwned(res, service, principal.owner, id)
    if (owned === undefined) return
    const result = await this.guarded(res, () => service.edit({
      id: owned.entry.id,
      action: 'update',
      patch,
      ...(body.revision === undefined ? {} : { expectedUpdatedAt: body.revision }),
    }))
    if (result !== undefined) this.respondEdit(res, id, owned.sessionId, result)
  }

  private async remove(res: ServerResponse, params: Record<string, string>, principal: Principal): Promise<void> {
    const service = this.service(res)
    if (service === undefined) return
    const id = routeParam(params, 'schedule_id')
    const owned = await this.loadOwned(res, service, principal.owner, id)
    if (owned === undefined) return
    const result = await this.guarded(res, () => service.edit({ id: owned.entry.id, action: 'delete' }))
    if (result !== undefined) this.respondEdit(res, id, owned.sessionId, result)
  }

  /**
   * Pause or resume a task.
   * @param res - outgoing response.
   * @param params - route captures.
   * @param principal - caller.
   * @param active - `false` pauses; `true` resumes from the first future occurrence.
   */
  private async setActive(res: ServerResponse, params: Record<string, string>, principal: Principal, active: boolean): Promise<void> {
    const service = this.service(res)
    if (service === undefined) return
    const id = routeParam(params, 'schedule_id')
    const owned = await this.loadOwned(res, service, principal.owner, id)
    if (owned === undefined) return
    const result = await this.guarded(res, () => service.edit({ id: owned.entry.id, action: 'update', patch: { active } }))
    if (result !== undefined) this.respondEdit(res, id, owned.sessionId, result)
  }

  private async run(res: ServerResponse, params: Record<string, string>, principal: Principal): Promise<void> {
    const service = this.service(res)
    if (service === undefined) return
    const id = routeParam(params, 'schedule_id')
    const owned = await this.loadOwned(res, service, principal.owner, id)
    if (owned === undefined) return
    const result = await this.guarded(res, () => service.run({ id: owned.entry.id }))
    if (result === undefined) return
    if ('code' in result) {
      if (result.code === 'schedule_execution_pending') conflict(res, 'schedule_execution_pending', `Schedule "${id}" already has a run in progress`)
      else scheduleNotFound(res, id)
      return
    }
    json(res, 200, toWireSchedule(result, owned.sessionId))
  }

  private async runs(res: ServerResponse, url: URL, params: Record<string, string>, principal: Principal): Promise<void> {
    const service = this.service(res)
    if (service === undefined) return
    const id = routeParam(params, 'schedule_id')
    const owned = await this.loadOwned(res, service, principal.owner, id)
    if (owned === undefined) return
    const before = url.searchParams.get('before')
    const result = await this.guarded(res, () => service.history({
      id: owned.entry.id,
      limit: listQuery(url).limit,
      ...(before === null || before === '' ? {} : { before: before as NonNullable<ScheduleDeliveryHistoryRequest['before']> }),
    }))
    if (result === undefined) return
    if ('code' in result) {
      if (result.code === 'schedule_not_found') scheduleNotFound(res, id)
      else badRequest(res, `Query "before" names no delivery of schedule "${id}"`)
      return
    }
    const records: ScheduleDeliveryRecord[] = result.records
    json(res, 200, {
      object: 'list',
      data: records.map(toWireRun),
      has_more: result.nextBefore !== undefined,
      next_before: result.nextBefore ?? null,
    })
  }
}
