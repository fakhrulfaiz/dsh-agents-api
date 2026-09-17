/**
 * Park Host function-tool `execute` until the client posts a tool result.
 */

import { mintEventId } from './bridge.ts'
import type { SessionRegistry } from './session-registry.ts'
import type { OAIRequiredAction } from './types.ts'

/** Outcome accepted from `tool_result` or legacy `function_call_output`. */
export type FunctionCallOutcome =
  | { success: true; output: string }
  | { success: false; error: string }

interface PendingEntry {
  action: Extract<OAIRequiredAction, { type: 'function_call' }>
  resolve: (output: string) => void
  reject: (error: Error) => void
  abortListener: () => void
  signal: AbortSignal
}

/**
 * Per-session waiters for client-executed function tools.
 *
 * When the model invokes a mounted wire function, Host `execute` parks here.
 * Completing the waiter unblocks the tool pipeline so the loop appends a real
 * `tool/result` and continues the turn.
 */
export class PendingFunctionCalls {
  private readonly pending = new Map<string, PendingEntry>()

  /**
   * @param sessionId - Agents API / Host session id.
   * @param registry - live session directory for status and SSE fan-out.
   */
  constructor(
    private readonly sessionId: string,
    private readonly registry: SessionRegistry,
  ) {}

  /**
   * Whether a call is waiting for a client result.
   * @param callId - Host / wire call id.
   * @returns true when a waiter is registered.
   */
  has(callId: string): boolean {
    return this.pending.has(callId)
  }

  /**
   * Park until the client posts a result for this call, or the Host signal aborts.
   * @param params - call identity, arguments, and cancellation signal.
   * @returns the client output string on success.
   */
  wait(params: {
    callId: string
    name: string
    arguments: Record<string, unknown>
    turnId: string
    signal: AbortSignal
  }): Promise<string> {
    const { callId, name, arguments: args, turnId, signal } = params
    if (this.pending.has(callId)) {
      return Promise.reject(new Error(`Function call "${callId}" is already waiting for a result`))
    }
    if (signal.aborted) {
      return Promise.reject(new Error(`Function call "${callId}" was cancelled before it started waiting`))
    }

    const action: Extract<OAIRequiredAction, { type: 'function_call' }> = {
      type: 'function_call',
      name,
      arguments: args,
      turn_id: turnId,
      call_id: callId,
    }

    return new Promise<string>((resolve, reject) => {
      const abortListener = (): void => {
        this.drop(callId, new Error(`Function call "${callId}" was cancelled`))
      }
      const entry: PendingEntry = {
        action,
        resolve,
        reject,
        abortListener,
        signal,
      }
      this.pending.set(callId, entry)
      signal.addEventListener('abort', abortListener, { once: true })
      this.syncRequiredActions(true)
    })
  }

  /**
   * Complete one pending call from a client input event.
   * @param callId - call id from `required_actions`.
   * @param outcome - success output or error message for the model.
   * @returns whether a waiter was found and settled.
   */
  complete(callId: string, outcome: FunctionCallOutcome): boolean {
    const entry = this.pending.get(callId)
    if (!entry) return false
    entry.signal.removeEventListener('abort', entry.abortListener)
    this.pending.delete(callId)
    this.syncRequiredActions(false)
    if (outcome.success) entry.resolve(outcome.output)
    else entry.reject(new Error(outcome.error))
    return true
  }

  /**
   * Reject every waiter (session delete or cancel).
   * @param reason - rejection error.
   */
  rejectAll(reason: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      entry.signal.removeEventListener('abort', entry.abortListener)
      entry.reject(reason)
    }
    this.syncRequiredActions(false)
  }

  private drop(callId: string, reason: Error): void {
    const entry = this.pending.get(callId)
    if (!entry) return
    entry.signal.removeEventListener('abort', entry.abortListener)
    this.pending.delete(callId)
    this.syncRequiredActions(false)
    entry.reject(reason)
  }

  private syncRequiredActions(emitRequiresAction: boolean): void {
    const actions: OAIRequiredAction[] = [...this.pending.values()].map(entry => entry.action)
    const session = this.registry.syncRequiredActions(this.sessionId, actions)
    if (!session) return
    if (emitRequiresAction && actions.length > 0) {
      this.registry.emit(this.sessionId, {
        type: 'agent.session.requires_action',
        event_id: mintEventId(),
        session,
      })
    }
  }
}
