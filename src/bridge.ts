/**
 * Subagent child projection and ephemeral event ids. The parent session's wire
 * events come from `WireProjector` (`history/projector.ts`).
 */

import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionRegistry } from './session-registry.ts'

/**
 * Mint one unique Agents API event id.
 * @returns an `evt_` id.
 */
export function mintEventId(): string {
  return `evt_${randomUUID().replaceAll('-', '')}`
}

/**
 * Project a Host child session onto its parent without mixing turns or items.
 *
 * Child events stay off the parent's logged stream; the registry announces
 * them as ephemeral `agent.session.subagent.*` events.
 *
 * @param parentId - Agents API session that owns the child.
 * @param childId - Host session id whose header says `origin: subagent`.
 * @param event - committed child Session event.
 * @param registry - live session directory.
 * @param createdAtMs - the child header's `createdAt` (epoch ms).
 */
export function bridgeChildSessionEvent(
  parentId: string,
  childId: string,
  event: SessionEvent,
  registry: SessionRegistry,
  createdAtMs?: number,
): void {
  registry.applyChildEvent(parentId, childId, event, createdAtMs)
}
