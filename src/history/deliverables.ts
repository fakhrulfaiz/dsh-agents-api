/** Files the agent declared with the `present` tool, read from the Session log. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One delivered file, as returned by `GET /v1/agents/sessions/{id}/deliverables`. */
export interface DeliverableEntry {
  /** Path as presented: absolute, or relative to the session workspace. */
  path: string
  description?: string
  /** Turn that presented the file, `turn_<seq of its turn/start>`. */
  turn_id: string
  /** Epoch seconds of the `deliverables/presented` event. */
  created_at: number
}

/** Persisted payload of `deliverables/presented`; read structurally because the type lives in an optional plugin. */
interface PresentedData {
  files?: ReadonlyArray<{ path?: unknown; description?: unknown }>
}

/**
 * @param events - the session's events, in log order.
 * @returns delivered files in presentation order; a path presented again keeps its first position with the latest description and turn.
 */
export function deliverablesFromEvents(events: readonly SessionEvent[]): DeliverableEntry[] {
  const byPath = new Map<string, DeliverableEntry>()
  let turnId = 'turn_default'
  for (const event of events) {
    if (event.type === 'turn/start') {
      turnId = `turn_${String(event.seq)}`
      continue
    }
    if ((event.type as string) !== 'deliverables/presented') continue
    const files = (event.data as PresentedData).files ?? []
    for (const file of files) {
      if (typeof file.path !== 'string' || file.path === '') continue
      const entry: DeliverableEntry = {
        path: file.path,
        ...(typeof file.description === 'string' && file.description !== '' ? { description: file.description } : {}),
        turn_id: turnId,
        created_at: Math.floor(event.time / 1000),
      }
      byPath.set(file.path, entry)
    }
  }
  return [...byPath.values()]
}
