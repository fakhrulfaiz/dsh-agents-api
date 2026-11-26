/**
 * Subagent child projection and ephemeral event ids. The parent session's wire
 * events come from `WireProjector` (`history/projector.ts`).
 */

import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { itemsFromEvent } from './items.ts'
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
 * Child events stay off the parent SSE stream. Callers stamp `subagent_id`
 * by storing the projection on the child record.
 *
 * @param parentId - Agents API session that owns the child.
 * @param childId - Host session id whose header says `origin: subagent`.
 * @param event - committed child Session event.
 * @param registry - live session directory.
 */
export function bridgeChildSessionEvent(
  parentId: string,
  childId: string,
  event: SessionEvent,
  registry: SessionRegistry,
): void {
  if (!registry.get(parentId)) return
  registry.ensureSubagent(parentId, childId)
  if (event.type === 'turn/start') {
    registry.openChildTurn(parentId, childId)
    return
  }
  const timer = registry.childTimer(parentId, childId)
  if (timer.note(event)) return
  const turn = registry.getCurrentChildTurn(parentId, childId)
  const turnId = turn?.id ?? 'turn_default'
  const projected = itemsFromEvent(event, turnId, { ...timer.context(event), sessionId: parentId }).map(item => ({ ...item, subagent_id: childId }))
  if (projected.length > 0) registry.appendChildItems(parentId, childId, projected)
  // The stored copies are what a result must end, so the timer tracks those.
  const stored = projected.length === 0 ? [] : (registry.listChildItems(parentId, childId) ?? []).slice(-projected.length)
  timer.settle(event, stored)
  if (event.type !== 'turn/end') return
  const data = event.data as { reason?: { kind: string; error?: { message?: string; code?: string } } }
  if (data.reason?.kind === 'error') {
    registry.finishChildTurn(parentId, childId, turnId, 'failed', {
      code: data.reason.error?.code ?? 'UNKNOWN',
      message: data.reason.error?.message ?? 'turn failed',
    })
    return
  }
  registry.finishChildTurn(parentId, childId, turnId, 'completed')
}
