/**
 * Restart recovery: bring sessions that were running at shutdown back, or mark
 * them `interrupted`.
 */

import { errorMessage } from './http.ts'
import type { SessionIndexRow, Store } from './store/store.ts'

/** Recorded on a running session that was created before migration 0002 and so has no stored setup. */
export const NO_STORED_CONFIG = 'session predates stored configuration'

/** Recovery cannot run because a Host capability it needs is missing. */
export class RecoveryUnavailableError extends Error {
  /** @param reason - what is missing. */
  constructor(reason: string) {
    super(`session recovery unavailable: ${reason}`)
    this.name = 'RecoveryUnavailableError'
  }
}

/** The Host's agent registry does not have the shape `recoveryUnavailable` probes; DSH changed and this plugin needs updating. */
export class RecoveryProbeError extends Error {
  /** @param detail - what was not found. */
  constructor(detail: string) {
    super(`cannot probe the agent registry: ${detail}`)
    this.name = 'RecoveryProbeError'
  }
}

/**
 * Check, without calling `resume`, that the Host can resume sessions. The agent
 * registry keeps the loop's factory in a field named `factory` that is `undefined`
 * until the agent loop plugin registers it; DSH exposes no public accessor.
 * @param agents - `ctx.agents`.
 * @param sessionPersistence - `ctx.sessionPersistence`.
 * @returns an error naming the missing capability, or `undefined` when both exist.
 * @throws RecoveryProbeError when `agents` has no `factory` field at all (not merely unset).
 */
export function recoveryUnavailable(agents: unknown, sessionPersistence: unknown): RecoveryUnavailableError | undefined {
  if (typeof agents !== 'object' || agents === null || !('factory' in agents)) {
    throw new RecoveryProbeError('ctx.agents has no `factory` field')
  }
  if ((agents as { factory?: unknown }).factory === undefined) return new RecoveryUnavailableError('no agent factory is registered yet')
  if (sessionPersistence === undefined) return new RecoveryUnavailableError('session persistence is not available')
  return undefined
}

/** Dependencies of `recoverSessions`. */
export interface RecoveryDeps {
  store: Store
  /**
   * Rebuild the agent of one session from its stored setup and Session log.
   * @param row - session index row with a stored setup.
   * @throws when the session cannot be resumed.
   */
  resume(row: SessionIndexRow): Promise<void>
}

/** Outcome of `recoverSessions`. */
export interface RecoveryResult {
  /** Ids resumed; their status is unchanged. */
  resumed: string[]
  /** Ids marked `interrupted`, with the reason stored as `lastError`. */
  interrupted: Array<{ id: string; reason: string }>
}

/**
 * Resume every `in_progress` or `requires_action` session, or mark it
 * `interrupted` with the reason in `lastError`. A rejected `resume` is the only
 * thing that interrupts a session with a stored setup; `resume` itself writes
 * the status the session resumes in.
 * @param deps - store and the resume operation.
 * @returns which sessions were resumed and which were interrupted.
 */
export async function recoverSessions(deps: RecoveryDeps): Promise<RecoveryResult> {
  const result: RecoveryResult = { resumed: [], interrupted: [] }
  for (const row of await deps.store.sessions.listResumable()) {
    let reason: string
    if (row.body === null) {
      reason = NO_STORED_CONFIG
    } else {
      try {
        await deps.resume(row)
        result.resumed.push(row.id)
        continue
      } catch (error: unknown) {
        reason = errorMessage(error)
      }
    }
    await deps.store.sessions.update(row.id, 'any', { status: 'interrupted', lastError: reason })
    result.interrupted.push({ id: row.id, reason })
  }
  return result
}
