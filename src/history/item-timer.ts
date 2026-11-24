/**
 * Timing that spans Session events: when each step started (for assistant
 * timing) and which saved tool calls still wait for their result (whose time
 * ends the call). One timer per projected session, parent or subagent.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ItemContext } from '../items.ts'
import type { OAISessionItem } from '../types.ts'

export class ItemTimer {
  readonly #stepStarts = new Map<string, number>()
  readonly #calls = new Map<string, OAISessionItem>()

  /** Records a `step/start`; true when the event only feeds timing. */
  note(event: SessionEvent): boolean {
    if (event.type !== 'step/start') return false
    const data = event.data as { turn?: unknown; step?: unknown }
    this.#stepStarts.set(`${String(data.turn)}:${String(data.step)}`, event.time)
    return true
  }

  /** What `itemsFromEvent` needs to time this event's items. */
  context(event: SessionEvent): ItemContext {
    const data = event.data as { turn?: unknown; step?: unknown }
    const started = typeof data.step === 'number' ? this.#stepStarts.get(`${String(data.turn)}:${String(data.step)}`) : undefined
    return started === undefined ? {} : { stepStartedAt: started }
  }

  /** Remembers a new call, or ends the call a result answers. */
  settle(event: SessionEvent, items: readonly OAISessionItem[]): void {
    if (event.type === 'tool/call') {
      const callId = (event.data as { callId?: unknown }).callId
      if (typeof callId === 'string' && items[0] !== undefined) this.#calls.set(callId, items[0])
      return
    }
    if (event.type !== 'tool/result') return
    const output = items.find(item => item.type === 'function_call_output')
    const call = output === undefined ? undefined : this.#calls.get(output.call_id)
    if (output === undefined || call === undefined || !('timing' in call)) return
    call.timing = { ...call.timing, completed_at_ms: event.time }
    this.#calls.delete(output.call_id)
  }
}
