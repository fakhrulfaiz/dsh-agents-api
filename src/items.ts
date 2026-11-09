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

/** First line of the framing the Host schedule service puts on a delivered reminder or reminder batch. */
const REMINDER_PREFIX = '[SCHEDULE REMINDER'

/**
 * @param text - framed message text.
 * @param key - line label such as `reminder_prompt_json`.
 * @returns the JSON value after `key: ` on its line, or `undefined` when the line is absent or not JSON.
 */
function framingJson(text: string, key: string): unknown {
  const line = text.split('\n').find(candidate => candidate.startsWith(`${key}: `))
  if (line === undefined) return undefined
  try {
    return JSON.parse(line.slice(key.length + 2)) as unknown
  } catch {
    // Malformed framing is shown as received, so a changed Host format never hides the message.
    return undefined
  }
}

/**
 * Read the task prompt out of the Host reminder framing.
 * @param text - full framed message text.
 * @returns the prompt and the task id when the framing names exactly one task; `undefined` when the framing is not recognized.
 */
function reminderPrompt(text: string): { prompt: string; scheduleId?: string } | undefined {
  if (text.startsWith('[SCHEDULE REMINDER BATCH]')) {
    const batch = framingJson(text, 'reminders_json')
    if (!Array.isArray(batch) || batch.length === 0) return undefined
    const prompts: string[] = []
    for (const reminder of batch as unknown[]) {
      const prompt = (reminder as { reminder_prompt?: unknown } | null)?.reminder_prompt
      if (typeof prompt !== 'string') return undefined
      prompts.push(prompt)
    }
    const id = (batch[0] as { schedule_id?: unknown }).schedule_id
    return { prompt: prompts.join('\n\n'), ...(batch.length === 1 && typeof id === 'string' ? { scheduleId: id } : {}) }
  }
  const prompt = framingJson(text, 'reminder_prompt_json')
  if (typeof prompt !== 'string') return undefined
  const id = framingJson(text, 'schedule_id_json')
  return { prompt, ...(typeof id === 'string' ? { scheduleId: id } : {}) }
}

/**
 * Project a `user/message` the Host schedule service delivered. Reminders and
 * reminder batches become user messages carrying the task prompt; other
 * `schedule`-sourced input, such as change notices, is model-only and shows no item.
 * @param seq - event position.
 * @param text - full framed message text.
 * @param turnId - current turn id.
 * @returns one user message item, or none.
 */
function scheduledPromptItems(seq: number, text: string, turnId: string): OAIMessageItem[] {
  if (!text.startsWith(REMINDER_PREFIX)) return []
  const reminder = reminderPrompt(text)
  return [{
    id: `item_msg_${String(seq)}`,
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: reminder?.prompt ?? text }],
    source: 'schedule',
    ...(reminder?.scheduleId === undefined ? {} : { schedule_id: reminder.scheduleId }),
    status: 'completed',
    turn_id: turnId,
  }]
}

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
    const data = event.data as { content?: unknown; source?: { kind?: string } }
    if (data.source?.kind === 'schedule') return scheduledPromptItems(event.seq, textFromContent(data.content), turnId)
    // Workspace instructions and runtime snapshots are plugin input, not the client's message.
    if (data.source?.kind !== 'user') return []
    const text = textFromContent(data.content)
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
      status: 'in_progress',
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
      error?: unknown
    }
    const message = data.message
    const firstBlock = Array.isArray(message?.content)
      ? message.content[0] as { toolCallId?: string; content?: unknown; isError?: boolean } | undefined
      : undefined
    const callId = String(
      message?.source?.kind === 'tool'
        ? message.source.callId
        : message?.callId
          ?? firstBlock?.toolCallId
          ?? `call_${String(event.seq)}`,
    )
    const output = textFromContent(
      firstBlock?.content ?? message?.content,
    )
    const isError = firstBlock?.isError === true || data.error !== undefined
    const fnOutItem: OAIFunctionCallOutputItem = {
      id: `item_fn_out_${String(event.seq)}`,
      type: 'function_call_output',
      call_id: callId,
      output,
      status: isError ? 'failed' : 'completed',
      turn_id: turnId,
      ...(isError ? { error: output || 'tool failed' } : {}),
    }
    return [fnOutItem]
  }

  return []
}
