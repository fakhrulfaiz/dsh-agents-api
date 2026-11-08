/**
 * Restart recovery: bring sessions that were running at shutdown back, or mark
 * them `interrupted`.
 */

import { errorMessage } from './http.ts'
import type { SessionIndexRow, Store } from './store/store.ts'

/** Recorded on a running session that was created before migration 0002 and so has no stored setup. */
export const NO_STORED_CONFIG = 'session predates stored configuration'

/** Resume failures that mean the process is misconfigured, not that one session is unrecoverable. */
const STARTUP_MISCONFIGURATION = ['no agent factory registered', 'cannot resume: session persistence is not configured']

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
 * @throws the resume error when it shows a startup misconfiguration (no agent factory, no session persistence); no row is changed for it.
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
        if (STARTUP_MISCONFIGURATION.some(message => reason.includes(message))) throw error
      }
    }
    await deps.store.sessions.update(row.id, 'any', { status: 'interrupted', lastError: reason })
    result.interrupted.push({ id: row.id, reason })
  }
  return result
}
