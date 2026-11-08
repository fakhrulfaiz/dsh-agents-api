/**
 * In-memory stand-in for `ctx.sessionQuery` and a recorded-event builder.
 *
 * `live` models sessions held in memory by this process; `cold` models logs
 * read from persistence after a restart, where session-query balances an open
 * tail turn with the real `interruptedTurnClosers`.
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionId, interruptedTurnClosers, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { EnvironmentProvider } from '../../src/environment/provider.ts'
import type { GatewayOptions } from '../../src/gateway.ts'
import { createSessionHistory } from '../../src/history/session-history.ts'

/**
 * Build one Session event.
 * @param type - event type.
 * @param data - event payload.
 * @param seq - log position.
 * @param time - epoch milliseconds; defaults to `seq` seconds so ordering is visible.
 */
export function logEvent(type: string, data: unknown, seq: number, time = seq * 1000): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

/** Fake `readSession` over per-session event lists. */
export class FakeSessionQuery implements Pick<SessionQueryEngine, 'readSession'> {
  readonly live = new Map<string, SessionEvent[]>()
  readonly cold = new Map<string, SessionEvent[]>()
  /** Working directory returned in every session header. */
  cwd = '/tmp/agentry-fake-cwd'
  /** Counts `readSession` calls. */
  reads = 0

  /**
   * Append an event to a live session's log, creating the log on first use.
   * @param id - session id.
   * @param event - event to log.
   */
  append(id: string, event: SessionEvent): void {
    const events = this.live.get(id) ?? []
    events.push(event)
    this.live.set(id, events)
  }

  /**
   * Simulate a process restart: live logs become cold logs.
   * @param id - session id; every session when omitted.
   */
  crash(id?: string): void {
    for (const key of id === undefined ? [...this.live.keys()] : [id]) {
      const events = this.live.get(key)
      if (events === undefined) continue
      this.cold.set(key, events)
      this.live.delete(key)
    }
  }

  readSession: SessionQueryEngine['readSession'] = (sessionId) => {
    this.reads += 1
    const id = String(sessionId)
    const live = this.live.get(id)
    const cold = this.cold.get(id)
    if (live === undefined && cold === undefined) {
      return Promise.reject(new SessionQueryError(`session "${id}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND'))
    }
    const events = live ?? [...cold!, ...interruptedTurnClosers(cold!)]
    return Promise.resolve({
      session: { version: 4, id: SessionId(id), createdAt: 0, cwd: this.cwd, isSeeded: false } as unknown as SessionHeader,
      inheritedEventCount: 0,
      events: structuredClone(events),
    } as Awaited<ReturnType<SessionQueryEngine['readSession']>>)
  }
}

/**
 * Gateway options for tests.
 * @param environments - environment provider.
 * @param query - fake session log; a new one when omitted.
 * @returns options with a temp workspaces root and history over `query`.
 */
export function testGatewayOptions(environments: EnvironmentProvider, query: FakeSessionQuery = new FakeSessionQuery()): GatewayOptions {
  return {
    environments,
    workspacesRoot: join(tmpdir(), 'agentry-gateway-spec-workspaces'),
    history: createSessionHistory(query),
  }
}
