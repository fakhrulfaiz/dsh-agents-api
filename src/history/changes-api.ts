/**
 * Per-turn changed files and diffs:
 *
 * - `GET /agents/sessions/:session_id/changes`: turns with a summary, newest first.
 * - `GET /agents/sessions/:session_id/turns/:turn_id/changes`: one turn's files.
 * - `GET /agents/sessions/:session_id/turns/:turn_id/changes/:index`: one file's diff.
 *
 * Local chats read DSH's `workspaceChanges` service (summaries announced by
 * `workspace/changes` log events); sandbox chats read the API's own sandbox
 * recorder. Both keep summaries in memory only. Files outside the workspace
 * are counted but never listed or diffed. Register before `/turns/:turn_id`.
 */
import type { ServerResponse } from 'node:http'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { OwnerId } from '../auth/authenticator.ts'
import { json, notFound, routeParam } from '../http.ts'
import type { Route } from '../gateway.ts'
import type { SandboxChanges } from './sandbox-changes.ts'
import { changeEventsByTurn, isOutside, toWireDiff, toWireSummary, turnIds, type ChangesSummary, type WorkspaceChangesLike } from './turn-changes.ts'

export interface ChangesApiDeps {
  requireSession(res: ServerResponse, owner: OwnerId, sessionId: string): Promise<unknown>
  /** The session's log, oldest first (empty when there is none). */
  events(sessionId: string): Promise<readonly SessionEvent[]>
  /** DSH's service, read at call time; absent means no changes for local chats. */
  workspaceChanges: () => WorkspaceChangesLike | undefined
  /** Whether the session runs on a sandbox (then the sandbox recorder answers). */
  isSandbox(owner: OwnerId, sessionId: string): Promise<boolean>
  sandbox: SandboxChanges
}

/** Where one session's summaries come from. */
interface Source {
  summaries(): Promise<Map<string, ChangesSummary | undefined>>
  diff(turnId: string, index: number, signal: AbortSignal): ReturnType<WorkspaceChangesLike['diff']>
}

export class ChangesApi {
  constructor(private readonly deps: ChangesApiDeps) {}

  routes(): Route[] {
    return [
      { method: 'GET', pattern: '/agents/sessions/:session_id/changes', handler: (_req, res, _url, params, p) => this.list(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/turns/:turn_id/changes', handler: (_req, res, _url, params, p) => this.turn(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/turns/:turn_id/changes/:index', handler: (_req, res, _url, params, p) => this.file(res, params, p.owner) },
    ]
  }

  private async source(owner: OwnerId, sessionId: string, events: readonly SessionEvent[]): Promise<Source> {
    if (await this.deps.isSandbox(owner, sessionId)) {
      const sandbox = this.deps.sandbox
      return {
        summaries: async () => new Map((await sandbox.list(sessionId)).map(entry => [entry.turnId, entry.summary])),
        diff: (turnId, index, signal) => sandbox.diff(sessionId, turnId, index, signal),
      }
    }
    const seqs = changeEventsByTurn(events)
    const service = this.deps.workspaceChanges()
    return {
      summaries: () => Promise.resolve(new Map([...seqs].map(([turnId, seq]) => [turnId, service?.summary(sessionId, seq)]))),
      diff: (turnId, index, signal) => {
        const seq = seqs.get(turnId)
        return seq === undefined || service === undefined ? Promise.resolve(undefined) : service.diff(sessionId, seq, index, signal)
      },
    }
  }

  private async list(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (await this.deps.requireSession(res, owner, sessionId) === undefined) return
    const events = await this.deps.events(sessionId)
    const order = [...turnIds(events)]
    const summaries = await (await this.source(owner, sessionId, events)).summaries()
    const data = order.reverse().flatMap((turnId) => {
      const wire = toWireSummary(turnId, summaries.get(turnId))
      return wire.available && wire.total + wire.outside > 0 ? [{ turn_id: turnId, total: wire.total, added: wire.added, deleted: wire.deleted, outside: wire.outside }] : []
    })
    json(res, 200, { object: 'list', data })
  }

  private async turn(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (await this.deps.requireSession(res, owner, sessionId) === undefined) return
    const turnId = routeParam(params, 'turn_id')
    const events = await this.deps.events(sessionId)
    if (!turnIds(events).has(turnId)) {
      notFound(res, 'turn not found')
      return
    }
    const summaries = await (await this.source(owner, sessionId, events)).summaries()
    json(res, 200, toWireSummary(turnId, summaries.get(turnId)))
  }

  private async file(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (await this.deps.requireSession(res, owner, sessionId) === undefined) return
    const turnId = routeParam(params, 'turn_id')
    const raw = routeParam(params, 'index')
    const index = /^\d{1,5}$/.test(raw) ? Number(raw) : -1
    const events = await this.deps.events(sessionId)
    const source = await this.source(owner, sessionId, events)
    const listed = (await source.summaries()).get(turnId)?.files[index]
    if (index < 0 || listed === undefined || isOutside(listed.path)) {
      notFound(res, 'These changes are no longer available.')
      return
    }
    const aborted = new AbortController()
    const onClose = (): void => { if (!res.writableEnded) aborted.abort() }
    res.on('close', onClose)
    try {
      const diff = await source.diff(turnId, index, aborted.signal)
      if (aborted.signal.aborted) return
      if (diff === undefined || isOutside(diff.path)) {
        notFound(res, 'These changes are no longer available.')
        return
      }
      json(res, 200, toWireDiff(diff))
    } catch {
      if (aborted.signal.aborted) return
      json(res, 503, { error: { type: 'server_error', code: 'changes_unavailable', message: 'The changes could not be read.' } })
    } finally {
      res.off('close', onClose)
    }
  }
}
