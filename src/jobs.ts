/**
 * A session's background jobs (DSH `ctx.jobs`, e.g. `run_in_background` shell
 * commands, workflows):
 *
 * - `GET /agents/sessions/:session_id/jobs`: the session's jobs with the newest 16 KiB of output each.
 * - `GET /agents/sessions/:session_id/jobs/:job_id`: one job with the newest 64 KiB of output.
 * - `POST /agents/sessions/:session_id/jobs/:job_id/kill`: request cancellation.
 *
 * Output is read with the registry's observer read (`readAt`), which never
 * moves the model's cursor, so the agent still collects everything with
 * `job_output`. Only jobs whose owner is this session are shown; the
 * registry's unowned jobs (visible to every caller) are left out. Jobs live in
 * process memory: after an API restart, or once the session's agent is
 * disposed, the list is empty. Live changes reach the session stream as
 * ephemeral `agent.session.job.updated` / `.removed` events
 * ({@link watchJobs}).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OwnerId } from './auth/authenticator.ts'
import { json, notFound, readBody, routeParam } from './http.ts'
import type { Route } from './gateway.ts'
import type { OAIJob, OAIJobOutput, OAISessionEvent } from './types.ts'

/** Output bytes a list entry carries. */
export const LIST_OUTPUT_BYTES = 16 * 1024
/** Output bytes a single-job read carries. */
export const JOB_OUTPUT_BYTES = 64 * 1024
/** Longest kill reason kept. */
const MAX_REASON = 200

type JobStatus = OAIJob['status']

/** The slice of DSH's `JobView` this module reads. */
export interface JobViewLike {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly owner?: string
  readonly status: JobStatus
  readonly progress?: string
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly output: { readonly total: number; readonly earliest: number }
}

/** One job event, as DSH's registry announces it. */
export type JobEventLike =
  | { readonly type: 'registered' | 'progress' | 'stopping' | 'removed'; readonly job: JobViewLike }
  | { readonly type: 'settled'; readonly job: JobViewLike }
  | { readonly type: 'output'; readonly id: string; readonly owner?: string; readonly total: number }

/**
 * The slice of DSH's `JobRegistry` (`ctx.jobs`) this module uses. DSH's branded
 * `JobId`/`SessionId` are strings at runtime, so the host casts its registry to this.
 */
export interface JobRegistryLike {
  list(caller: string): readonly JobViewLike[]
  get(id: string, caller: string): JobViewLike
  readAt(id: string, from: number, caller: string): { chunks: ReadonlyArray<{ readonly at: number; readonly text: string }>; next: number; lossy: boolean }
  kill(id: string, caller: string, reason?: string): 'requested' | 'already-finished'
  readonly events: { subscribe(filter: { owners: 'all' }, listener: (event: JobEventLike) => void): () => void }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * The exit code in a completed shell job's terminal detail (`exit code: 3`).
 * @param view - the job.
 * @returns the code, or null for other jobs and states.
 */
export function exitCodeOf(view: Pick<JobViewLike, 'status' | 'detail'>): number | null {
  if (view.status !== 'completed' || view.detail === undefined) return null
  const match = /exit code: (-?\d+)/.exec(view.detail)
  return match === null ? null : Number(match[1])
}

const seconds = (ms: number): number => Math.floor(ms / 1000)

/**
 * Wire shape of one job.
 * @param view - the registry projection.
 * @param sessionId - the owning session.
 * @param output - retained output, when the response carries it.
 * @returns the `agent.session.job` resource.
 */
export function jobResource(view: JobViewLike, sessionId: string, output?: OAIJobOutput): OAIJob {
  return {
    id: view.id,
    object: 'agent.session.job',
    session_id: sessionId,
    kind: view.kind,
    command: view.label,
    status: view.status,
    detail: view.progress ?? view.detail ?? null,
    exit_code: exitCodeOf(view),
    started_at: seconds(view.startedAt),
    finished_at: view.finishedAt === undefined ? null : seconds(view.finishedAt),
    ...output === undefined ? {} : { output },
  }
}

/**
 * The newest `maxBytes` of a job's retained output, without moving the model's cursor.
 * @param jobs - the registry.
 * @param view - the job.
 * @param sessionId - the caller session.
 * @param maxBytes - bound in UTF-8 bytes.
 * @returns the text, the stream's total, and whether earlier bytes are missing.
 */
export function readTail(jobs: JobRegistryLike, view: JobViewLike, sessionId: string, maxBytes: number): OAIJobOutput {
  const total = view.output.total
  const from = Math.max(0, total - maxBytes)
  const read = jobs.readAt(view.id, from, sessionId)
  let bytes = encoder.encode(read.chunks.map(chunk => chunk.text).join(''))
  let cut = read.lossy || from > 0
  if (bytes.byteLength > maxBytes) {
    bytes = bytes.subarray(bytes.byteLength - maxBytes)
    cut = true
  }
  // A cut can land inside a multi-byte character; drop its continuation bytes.
  let start = 0
  while (start < bytes.byteLength && start < 4 && (bytes[start]! & 0xc0) === 0x80) start += 1
  return { text: decoder.decode(bytes.subarray(start)), total_bytes: total, truncated: cut }
}

export interface JobsApiDeps {
  requireSession(res: ServerResponse, owner: OwnerId, sessionId: string): Promise<unknown>
  /** DSH's job registry, read at call time; absent means no jobs. */
  jobs: () => JobRegistryLike | undefined
}

export class JobsApi {
  constructor(private readonly deps: JobsApiDeps) {}

  routes(): Route[] {
    return [
      { method: 'GET', pattern: '/agents/sessions/:session_id/jobs', handler: (_req, res, _url, params, p) => this.list(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/jobs/:job_id', handler: (_req, res, _url, params, p) => this.get(res, params, p.owner) },
      { method: 'POST', pattern: '/agents/sessions/:session_id/jobs/:job_id/kill', handler: (req, res, _url, params, p) => this.kill(req, res, params, p.owner) },
    ]
  }

  /** This session's own jobs, oldest first (the registry also lists unowned jobs to every caller). */
  private owned(jobs: JobRegistryLike, sessionId: string): JobViewLike[] {
    return jobs.list(sessionId).filter(view => view.owner === sessionId)
  }

  private find(jobs: JobRegistryLike | undefined, sessionId: string, jobId: string): JobViewLike | undefined {
    return jobs === undefined ? undefined : this.owned(jobs, sessionId).find(view => view.id === jobId)
  }

  private async list(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (await this.deps.requireSession(res, owner, sessionId) === undefined) return
    const jobs = this.deps.jobs()
    const data = jobs === undefined ? [] : this.owned(jobs, sessionId).map(view => jobResource(view, sessionId, readTail(jobs, view, sessionId, LIST_OUTPUT_BYTES)))
    json(res, 200, { object: 'list', data })
  }

  private async get(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (await this.deps.requireSession(res, owner, sessionId) === undefined) return
    const jobs = this.deps.jobs()
    const view = this.find(jobs, sessionId, routeParam(params, 'job_id'))
    if (jobs === undefined || view === undefined) {
      notFound(res, 'job not found')
      return
    }
    json(res, 200, jobResource(view, sessionId, readTail(jobs, view, sessionId, JOB_OUTPUT_BYTES)))
  }

  private async kill(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (await this.deps.requireSession(res, owner, sessionId) === undefined) return
    const body = await readBody(req)
    const jobs = this.deps.jobs()
    const jobId = routeParam(params, 'job_id')
    if (jobs === undefined || this.find(jobs, sessionId, jobId) === undefined) {
      notFound(res, 'job not found')
      return
    }
    const given = typeof body['reason'] === 'string' ? body['reason'].trim().slice(0, MAX_REASON) : ''
        let outcome: 'requested' | 'already-finished'
    try {
      outcome = jobs.kill(jobId, sessionId, given.length > 0 ? given : 'stopped by the user')
    } catch {
      notFound(res, 'job not found')
      return
    }
    const view = jobs.get(jobId, sessionId)
    json(res, 200, { outcome: outcome === 'requested' ? 'cancellation_requested' : 'already_finished', job: jobResource(view, sessionId) })
  }
}

/**
 * Announce job changes on their session's stream as ephemeral events:
 * `agent.session.job.updated` on registration, progress, stopping and
 * settlement, `agent.session.job.removed` when a record leaves the list (a
 * foreground shell call that finished in time). Output appends are not
 * announced; a client re-reads the job.
 * @param jobs - the registry.
 * @param emit - fan-out to the session's subscribers (a no-op for sessions nobody streams).
 * @param mintId - event id factory.
 * @returns the unsubscriber.
 */
export function watchJobs(jobs: JobRegistryLike, emit: (sessionId: string, event: OAISessionEvent) => void, mintId: () => string): () => void {
  return jobs.events.subscribe({ owners: 'all' }, (event) => {
    if (event.type === 'output') return
    const sessionId = event.job.owner
    if (sessionId === undefined) return
    if (event.type === 'removed') {
      emit(sessionId, { type: 'agent.session.job.removed', event_id: mintId(), session_id: sessionId, job_id: event.job.id })
      return
    }
    emit(sessionId, { type: 'agent.session.job.updated', event_id: mintId(), session_id: sessionId, job: jobResource(event.job, sessionId) })
  })
}
