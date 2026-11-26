/**
 * In-memory `ScheduleService` with the semantics the schedule routes rely on:
 * catalog order as stored, `updatedAt` revisions with conflict detection,
 * newest-first delivery history, and a record of every call.
 */

import type { ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleRecord, ScheduleService, ScheduleTiming } from '@deepseek-ai/dsh-schedule'

/** One recorded service call. */
export interface ScheduleCall {
  method: 'catalog' | 'view' | 'create' | 'edit' | 'run' | 'history'
  args: unknown[]
}

/** A saved delivery as the service returns it. */
export interface FakeDelivery {
  scheduledAt: string
  deliveredAt: string
  messageId: string
  targetSessionId: string
}

const MUTATING = new Set<ScheduleCall['method']>(['create', 'edit', 'run'])

/**
 * Build the stored rule for `timing` at a fixed future instant.
 * @param id - task id.
 * @param title - task title.
 * @param prompt - task prompt.
 * @param timing - requested timing.
 * @param scheduledAt - committed next occurrence.
 */
export function recordFor(id: string, title: string, prompt: string, timing: ScheduleTiming, scheduledAt: string): ScheduleRecord {
  const base = { id, title, prompt, scheduledAt }
  return stored(timing, base)
}

/** Add the kind-specific members of a rule. */
function stored(timing: ScheduleTiming, base: { id: string; title: string; prompt: string; scheduledAt: string }): ScheduleRecord {
  switch (timing.kind) {
    case 'after': return ({ ...base, kind: 'after', afterSeconds: timing.after_seconds }) as ScheduleRecord
    case 'at': return ({ ...base, kind: 'at' }) as ScheduleRecord
    case 'every': return ({ ...base, kind: 'every', everySeconds: timing.every_seconds }) as ScheduleRecord
    case 'daily': return ({ ...base, kind: 'daily', time: normalizeTime(timing.daily.time), timeZone: timing.daily.time_zone }) as ScheduleRecord
    case 'weekly': return ({ ...base, kind: 'weekly', time: normalizeTime(timing.weekly.time), timeZone: timing.weekly.time_zone, weekdays: timing.weekly.weekdays }) as ScheduleRecord
    case 'cron': return ({ ...base, kind: 'cron', expression: timing.cron.expression, timeZone: timing.cron.time_zone }) as ScheduleRecord
    case 'rrule': return ({ ...base, kind: 'rrule', rrule: timing.rrule }) as ScheduleRecord
  }
}

/**
 * @param time - `HH:mm`, `HH:mm:ss`, or `HH:mm:ss.S`.
 * @returns `HH:mm:ss.SSS`.
 */
function normalizeTime(time: string): string {
  const [clock = '', fraction = ''] = time.split('.')
  const parts = clock.split(':')
  while (parts.length < 3) parts.push('00')
  return `${parts.join(':')}.${fraction.padEnd(3, '0')}`
}

/** Fake `ScheduleService`; seed `entries` and `deliveries`, read `calls`. */
export class FakeSchedule {
  /** Stored tasks in catalog order. */
  entries: ScheduleCatalogEntry[] = []
  /** Saved deliveries by task id, newest first. */
  deliveries = new Map<string, FakeDelivery[]>()
  /** Every call, in order. */
  calls: ScheduleCall[] = []
  /** When set, `create` rejects with this error. */
  createError: Error | undefined
  /** When set, `run` rejects with this error. */
  runError: Error | undefined
  /** When true, `run` answers `schedule_execution_pending`. */
  runPending = false
  #clock = Date.parse('2026-11-10T00:00:00.000Z')
  #seq = 0

  /** The service view the gateway receives. */
  readonly service = {
    deliveryLimits: () => ({ newSessionIntervalSeconds: 60 }),
    catalog: async () => this.#record('catalog', [], () => [...this.entries]),
    view: async (request: { id: string }) => this.#record('view', [request], () => this.entries.find(entry => entry.id === request.id) ?? { id: request.id, code: 'schedule_not_found' as const }),
    create: async (request: ScheduleCreateRequest, actor?: string) => this.#record('create', [request, actor], () => {
      if (this.createError !== undefined) throw this.createError
      const id = `schedule-${String(++this.#seq)}`
      const at = this.#tick()
      const target = request.target as { kind: 'session'; sessionId: string }
      const entry = {
        ...recordFor(id, request.title, request.prompt, request.timing, '2026-11-11T08:00:00.000Z'),
        target,
        involvedSessionIds: [...new Set([actor, target.sessionId].filter((value): value is string => value !== undefined))],
        status: 'active' as const,
        createdAt: at,
        updatedAt: at,
      } as unknown as ScheduleCatalogEntry
      this.entries.push(entry)
      return entry
    }),
    edit: async (request: { id: string; action: 'update' | 'delete'; patch?: { title?: string; prompt?: string; timing?: ScheduleTiming; active?: boolean }; expectedUpdatedAt?: string | null }, actor?: string) =>
      this.#record('edit', [request, actor], () => {
        const index = this.entries.findIndex(entry => entry.id === request.id)
        const current = this.entries[index]
        if (current === undefined) return { id: request.id, code: 'schedule_not_found' as const }
        if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (current.updatedAt ?? null)) {
          return { id: request.id, code: 'schedule_conflict' as const }
        }
        if (request.action === 'delete') {
          this.entries.splice(index, 1)
          return { id: request.id, deleted: true as const }
        }
        const patch = request.patch ?? {}
        const record = patch.timing === undefined
          ? current
          : recordFor(current.id, current.title, current.prompt, patch.timing, current.scheduledAt)
        const next = {
          ...current,
          ...record,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
          ...(patch.active === undefined ? {} : { status: patch.active ? 'active' as const : 'paused' as const }),
          updatedAt: this.#tick(),
        } as ScheduleCatalogEntry
        this.entries[index] = next
        return next
      }),
    run: async (request: { id: string }) => this.#record('run', [request], () => {
      if (this.runError !== undefined) throw this.runError
      const entry = this.entries.find(candidate => candidate.id === request.id)
      if (entry === undefined) return { id: request.id, code: 'schedule_not_found' as const }
      if (this.runPending) return { id: request.id, code: 'schedule_execution_pending' as const }
      return entry
    }),
    history: async (request: { id: string; limit: number; before?: string }) => this.#record('history', [request], () => {
      if (!this.entries.some(entry => entry.id === request.id)) return { id: request.id, code: 'schedule_not_found' as const }
      const all = this.deliveries.get(request.id) ?? []
      let start = 0
      if (request.before !== undefined) {
        const at = all.findIndex(record => record.messageId === request.before)
        if (at === -1) return { id: request.id, code: 'delivery_cursor_not_found' as const }
        start = at + 1
      }
      const records = all.slice(start, start + request.limit)
      const more = start + records.length < all.length
      return {
        id: request.id,
        records,
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 30, records: 200 },
        ...(more ? { nextBefore: records.at(-1)!.messageId } : {}),
      }
    }),
  }

  /** @returns the fake typed as the real service. */
  asService(): ScheduleService {
    return this.service as unknown as ScheduleService
  }

  /** @returns the names of the mutating methods that were called. */
  mutatingCalls(): ScheduleCall[] {
    return this.calls.filter(call => MUTATING.has(call.method))
  }

  /**
   * Add a stored task.
   * @param entry - fields of the catalog entry; defaults describe an active daily task.
   * @returns the stored entry.
   */
  add(entry: { id: string; target: { kind: 'session' | 'new_once' | 'new'; sessionId?: string; create?: object }; involvedSessionIds?: string[]; status?: 'active' | 'paused' | 'ended' }): ScheduleCatalogEntry {
    const stored = {
      ...recordFor(entry.id, 'Task', 'Do the thing', { kind: 'daily', daily: { time: '08:00', time_zone: 'UTC' } }, '2026-11-11T08:00:00.000Z'),
      involvedSessionIds: [],
      status: 'active',
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
      ...entry,
    } as unknown as ScheduleCatalogEntry
    this.entries.push(stored)
    return stored
  }

  #tick(): string {
    this.#clock += 1000
    return new Date(this.#clock).toISOString()
  }

  #record<T>(method: ScheduleCall['method'], args: unknown[], run: () => T): T {
    this.calls.push({ method, args })
    return run()
  }
}

/** Stand-in for the Host `ScheduleInputError`, which the routes recognise by name and `code`. */
class ScheduleInputError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ScheduleInputError'
    this.code = code
  }
}

/**
 * @param code - Host input code.
 * @returns the error the Host service raises for rejected input.
 */
export function inputError(code: string): Error {
  return new ScheduleInputError(code, `schedule rejected: ${code}`)
}
