/**
 * Park Host function-tool `execute` until the client posts a tool result.
 */

/** Outcome accepted from `tool_result` or legacy `function_call_output`. */
export type FunctionCallOutcome =
  | { success: true; output: string }
  | { success: false; error: string }

interface PendingEntry {
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
 * `tool/result` and continues the turn. `required_actions` and the
 * `requires_action` status are not set here: they derive from the logged
 * `tool/call` and `tool/result` events (`history/projector.ts`).
 */
export class PendingFunctionCalls {
  private readonly pending = new Map<string, PendingEntry>()

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
   * @param params - call id and cancellation signal.
   * @returns the client output string on success.
   */
  wait(params: { callId: string; signal: AbortSignal }): Promise<string> {
    const { callId, signal } = params
    if (this.pending.has(callId)) {
      return Promise.reject(new Error(`Function call "${callId}" is already waiting for a result`))
    }
    if (signal.aborted) {
      return Promise.reject(new Error(`Function call "${callId}" was cancelled before it started waiting`))
    }

    return new Promise<string>((resolve, reject) => {
      const abortListener = (): void => {
        this.drop(callId, new Error(`Function call "${callId}" was cancelled`))
      }
      this.pending.set(callId, { resolve, reject, abortListener, signal })
      signal.addEventListener('abort', abortListener, { once: true })
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
  }

  private drop(callId: string, reason: Error): void {
    const entry = this.pending.get(callId)
    if (!entry) return
    entry.signal.removeEventListener('abort', entry.abortListener)
    this.pending.delete(callId)
    entry.reject(reason)
  }
}
