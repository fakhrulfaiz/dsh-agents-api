/**
 * Project one Session event into saved Agents API items.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseToolArguments, textFromContent } from './input.ts'
import type {
  OAICommandExecutionItem,
  OAIFunctionCallItem,
  OAIFunctionCallOutputItem,
  OAIMessageItem,
  OAIReasoningItem,
  OAISessionItem,
} from './types.ts'

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal'])

/**
 * Convert one committed Session event into zero or more saved items.
 *
 * Live listing accumulates these items as `session/event` fires. This function
 * does not read historical Session logs.
 *
 * @param event - committed Session event.
 * @param turnId - current Agents API turn id for this session.
 * @returns items to append, in log order.
 */
export function itemsFromEvent(event: SessionEvent, turnId: string): OAISessionItem[] {
  if (event.type === 'user/message') {
    const text = textFromContent((event.data as { content?: unknown }).content)
    const item: OAIMessageItem = {
      id: `item_msg_${String(event.seq)}`,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
      status: 'completed',
      turn_id: turnId,
    }
    return [item]
  }

  if (event.type === 'assistant/message') {
    const data = event.data as {
      message?: { content?: unknown }
      stream?: Array<{ type: string; texts?: string[] }>
    }
    const items: OAISessionItem[] = []
    if (data.stream) {
      for (const rec of data.stream) {
        if (rec.type === 'reasoning-chunks' && Array.isArray(rec.texts)) {
          const rText = rec.texts.join('')
          if (rText) {
            const rItem: OAIReasoningItem = {
              id: `item_reason_${String(event.seq)}`,
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: rText }],
              status: 'completed',
              turn_id: turnId,
            }
            items.push(rItem)
          }
        }
      }
    }
    const text = textFromContent(data.message?.content)
    const msgItem: OAIMessageItem = {
      id: `item_msg_${String(event.seq)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
      status: 'completed',
      turn_id: turnId,
    }
    items.push(msgItem)
    return items
  }

  if (event.type === 'tool/call') {
    const data = event.data as {
      callId?: string
      name?: string
      arguments?: unknown
    }
    const name = typeof data.name === 'string' ? data.name : 'unknown_tool'
    const callId = typeof data.callId === 'string' ? data.callId : `call_${String(event.seq)}`
    const args = parseToolArguments(data.arguments)
    if (SHELL_TOOLS.has(name)) {
      const commandRaw = args.command ?? args.cmd
      const cmdItem: OAICommandExecutionItem = {
        id: `item_cmd_${String(event.seq)}`,
        type: 'command_execution',
        command: typeof commandRaw === 'string' ? commandRaw : '',
        status: 'completed',
        turn_id: turnId,
        ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
      }
      return [cmdItem]
    }
    const fnItem: OAIFunctionCallItem = {
      id: `item_fn_${String(event.seq)}`,
      type: 'function_call',
      name,
      call_id: callId,
      arguments: args,
      status: 'completed',
      turn_id: turnId,
    }
    return [fnItem]
  }

  if (event.type === 'tool/result') {
    const data = event.data as {
      message?: {
        callId?: string
        source?: { kind?: string; callId?: string }
        content?: unknown
      }
    }
    const message = data.message
    const callId = String(
      message?.source?.kind === 'tool'
        ? message.source.callId
        : message?.callId
          ?? (Array.isArray(message?.content)
            ? (message.content[0] as { toolCallId?: string } | undefined)?.toolCallId
            : undefined)
          ?? `call_${String(event.seq)}`,
    )
    const output = textFromContent(
      Array.isArray(message?.content)
        ? (message.content[0] as { content?: unknown } | undefined)?.content ?? message.content
        : message?.content,
    )
    const fnOutItem: OAIFunctionCallOutputItem = {
      id: `item_fn_out_${String(event.seq)}`,
      type: 'function_call_output',
      call_id: callId,
      output,
      status: 'completed',
      turn_id: turnId,
    }
    return [fnOutItem]
  }

  return []
}
