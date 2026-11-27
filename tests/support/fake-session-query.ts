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
import type { SandboxProvider } from '../../src/sandbox/contract.ts'
import { SandboxRegistry } from '../../src/sandbox/registry.ts'
import type { GatewayOptions } from '../../src/gateway.ts'
import type { ApprovalBridge } from '../../src/approvals/approval-bridge.ts'
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

/** Header fields a test can set per session: lineage, creation time, and a fork's inherited prefix. */
export interface FakeHeader {
  parentSession?: string
  origin?: 'subagent'
  /** Epoch milliseconds; 0 when omitted. */
  createdAt?: number
  /** Number of leading events inherited from the parent; 0 when omitted. */
  inheritedEventCount?: number
}

/** Fake `readSession` and `traceSession` over per-session event lists. */
export class FakeSessionQuery implements Pick<SessionQueryEngine, 'readSession' | 'traceSession'> {
  /** Per-session header fields; sessions without an entry have no parent. */
  readonly headers = new Map<string, FakeHeader>()
  readonly live = new Map<string, SessionEvent[]>()
  readonly cold = new Map<string, SessionEvent[]>()
  /** Working directory returned in every session header. */
  cwd = '/tmp/agentry-fake-cwd'
  /** Counts `readSession` calls. */
  reads = 0
  /** When set, `readSession` waits for it before observing the log, so events appended meanwhile are in the snapshot. */
  gateBeforeSnapshot: Promise<void> | undefined
  /** When set, `readSession` waits for it after observing the log, so events appended meanwhile are missing from the snapshot. */
  gateAfterSnapshot: Promise<void> | undefined

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

  readSession: SessionQueryEngine['readSession'] = async (sessionId) => {
    this.reads += 1
    const id = String(sessionId)
    await this.gateBeforeSnapshot
    const live = this.live.get(id)
    const cold = this.cold.get(id)
    if (live === undefined && cold === undefined) {
      throw new SessionQueryError(`session "${id}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
    }
    const events = structuredClone(live ?? [...cold!, ...interruptedTurnClosers(cold!)])
    await this.gateAfterSnapshot
    return {
      session: this.#header(id),
      inheritedEventCount: this.headers.get(id)?.inheritedEventCount ?? 0,
      events,
    } as Awaited<ReturnType<SessionQueryEngine['readSession']>>
  }

  #header(id: string): SessionHeader {
    const extra = this.headers.get(id) ?? {}
    return {
      version: 4,
      id: SessionId(id),
      createdAt: extra.createdAt ?? 0,
      cwd: this.cwd,
      isSeeded: false,
      ...(extra.parentSession === undefined ? {} : { parentSession: SessionId(extra.parentSession) }),
      ...(extra.origin === undefined ? {} : { origin: extra.origin }),
    } as unknown as SessionHeader
  }

  /** Lineage over every known session (one with a log, a header, or a child); a session with a live log is `live`. Only direct children are listed under the target. */
  traceSession: SessionQueryEngine['traceSession'] = async (sessionId) => {
    const id = String(sessionId)
    const parents = [...this.headers.values()].flatMap(header => header.parentSession === undefined ? [] : [header.parentSession])
    const ids = new Set([...this.live.keys(), ...this.cold.keys(), ...this.headers.keys(), ...parents])
    if (!ids.has(id)) throw new SessionQueryError(`session "${id}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
    const record = (key: string) => ({ header: this.#header(key), live: this.live.has(key), persisted: true })
    const descendants = [...ids]
      .filter(key => this.headers.get(key)?.parentSession === id)
      .map(key => ({ session: record(key), descendants: [] }))
    return Promise.resolve({ target: record(id), ancestors: [], descendants, complete: true, root: record(id) } as Awaited<ReturnType<SessionQueryEngine['traceSession']>>)
  }
}

/** Bridge with nothing ever pending, for tests that do not exercise approvals. */
export const inertApprovals: ApprovalBridge = {
  pending: () => [],
  answer: () => 'not_found',
  cancelAll: () => undefined,
}

/**
 * Gateway options for tests.
 * @param sandboxes - one provider (registered as the default) or a ready registry.
 * @param query - fake session log; a new one when omitted.
 * @param approvals - pending approvals; none when omitted.
 * @returns options with a temp workspaces root and history over `query`.
 */
export function testGatewayOptions(sandboxes: SandboxProvider | SandboxRegistry, query: FakeSessionQuery = new FakeSessionQuery(), approvals: ApprovalBridge = inertApprovals): GatewayOptions {
  let registry: SandboxRegistry
  if (sandboxes instanceof SandboxRegistry) registry = sandboxes
  else {
    registry = new SandboxRegistry(sandboxes.kind)
    registry.register(sandboxes)
  }
  return {
    sandboxes: registry,
    workspacesRoot: join(tmpdir(), 'agentry-gateway-spec-workspaces'),
    history: createSessionHistory(query),
    approvals,
    schedule: () => undefined,
    skills: () => undefined,
    skillsTtlMs: 60_000,
    commands: () => undefined,
    commandsTtlMs: 60_000,
  }
}
