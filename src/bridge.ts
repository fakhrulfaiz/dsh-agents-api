/**
 * Project Host Session events onto Agents API SSE events and saved items.
 */

import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { itemsFromEvent } from './items.ts'
import { textFromContent, toOAIUsage } from './input.ts'
import type { SessionRegistry } from './session-registry.ts'

/**
 * Mint one unique Agents API event id.
 * @returns an `evt_` id.
 */
export function mintEventId(): string {
  return `evt_${randomUUID().replaceAll('-', '')}`
}

/**
 * Fan Session log events out as Agents API SSE events and accumulate items.
 *
 * Unknown Session event types are ignored so a newer Host event cannot break
 * the gateway.
 *
 * @param sessionId - Agents API / Host session id.
 * @param event - committed Session event.
 * @param registry - live session directory.
 */
export function bridgeSessionEvent(
  sessionId: string,
  event: SessionEvent,
  registry: SessionRegistry,
): void {
  const state = registry.get(sessionId)
  if (!state) return

  if (event.type === 'turn/start') {
    const turn = registry.getCurrentTurn(sessionId) ?? registry.openTurn(state)
    const session = registry.project(state)
    registry.emit(sessionId, {
      type: 'agent.session.in_progress',
      event_id: mintEventId(),
      session,
    })
    registry.emit(sessionId, {
      type: 'agent.session.turn.created',
      event_id: mintEventId(),
      session_id: sessionId,
      turn,
    })
    registry.emit(sessionId, {
      type: 'agent.session.turn.in_progress',
      event_id: mintEventId(),
      session_id: sessionId,
      turn,
    })
    return
  }

  const turn = registry.getCurrentTurn(sessionId)
  const turnId = turn?.id ?? 'turn_default'
  const projected = itemsFromEvent(event, turnId)
  if (projected.length > 0) registry.appendItems(sessionId, projected)

  if (event.type === 'assistant/message') {
    emitAssistantMessage(sessionId, event, turnId, registry)
    return
  }

  if (event.type === 'turn/end') {
    const data = event.data as {
      usage?: TokenUsage
      reason?: { kind: string; error?: { message?: string; code?: string } }
    }
    const usage = toOAIUsage(data.usage)
    if (data.reason?.kind === 'error') {
      const failed = registry.failTurn(sessionId, turnId, {
        code: data.reason.error?.code ?? 'UNKNOWN',
        message: data.reason.error?.message ?? 'turn failed',
      })
      if (failed) {
        registry.emit(sessionId, {
          type: 'agent.session.turn.failed',
          event_id: mintEventId(),
          session_id: sessionId,
          turn_id: turnId,
          turn: failed,
          ...(usage ? { usage } : {}),
        })
      }
    } else {
      const completed = registry.completeTurn(sessionId, turnId, usage)
      if (completed) {
        registry.emit(sessionId, {
          type: 'agent.session.turn.completed',
          event_id: mintEventId(),
          session_id: sessionId,
          turn_id: turnId,
          turn: completed,
          ...(completed.usage ? { usage: completed.usage } : {}),
        })
      }
    }
    registry.emit(sessionId, {
      type: 'agent.session.idle',
      event_id: mintEventId(),
      session: registry.project(state),
    })
  }
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
  const turn = registry.getCurrentChildTurn(parentId, childId)
  const turnId = turn?.id ?? 'turn_default'
  const projected = itemsFromEvent(event, turnId).map(item => ({ ...item, subagent_id: childId }))
  if (projected.length > 0) registry.appendChildItems(parentId, childId, projected)
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

function emitAssistantMessage(
  sessionId: string,
  event: SessionEvent,
  turnId: string,
  registry: SessionRegistry,
): void {
  const data = event.data as {
    message?: { content?: unknown }
    stream?: Array<{ type: string; texts?: string[] }>
  }
  const itemId = `item_msg_${String(event.seq)}`
  registry.emit(sessionId, {
    type: 'agent.session.turn.item.added',
    event_id: mintEventId(),
    session_id: sessionId,
    turn_id: turnId,
    item: {
      id: itemId,
      type: 'message',
      role: 'assistant',
      content: [],
      status: 'in_progress',
      turn_id: turnId,
    },
  })

  let fullText = ''
  for (const rec of data.stream ?? []) {
    if (rec.type === 'text-chunks' && Array.isArray(rec.texts)) {
      for (const chunk of rec.texts) {
        fullText += chunk
        registry.emit(sessionId, {
          type: 'agent.session.turn.output_text.delta',
          event_id: mintEventId(),
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          session_id: sessionId,
          turn_id: turnId,
          delta: chunk,
        })
      }
    }
  }
  if (!fullText) {
    fullText = textFromContent(data.message?.content)
    if (fullText) {
      registry.emit(sessionId, {
        type: 'agent.session.turn.output_text.delta',
        event_id: mintEventId(),
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        session_id: sessionId,
        turn_id: turnId,
        delta: fullText,
      })
    }
  }

  registry.emit(sessionId, {
    type: 'agent.session.turn.output_text.done',
    event_id: mintEventId(),
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    session_id: sessionId,
    turn_id: turnId,
    text: fullText,
  })
  registry.emit(sessionId, {
    type: 'agent.session.turn.item.done',
    event_id: mintEventId(),
    session_id: sessionId,
    turn_id: turnId,
    item: {
      id: itemId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: fullText }],
      status: 'completed',
      turn_id: turnId,
    },
  })
}
