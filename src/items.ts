/**
 * Project one Session event into saved Agents API items.
 */

import { connectRequestFrom } from './connect-request.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ATTACHMENT_NOTE_PREFIX } from './files/note.ts'
import { typeFromExtension } from './files/sniff.ts'
import { outputImageParts } from './files/tool-images.ts'
import { parseToolArguments, textFromContent, toOAIUsage } from './input.ts'
import type {
  OAICommandExecutionItem,
  OAIInputFilePart,
  OAIFunctionCallItem,
  OAIFunctionCallOutputItem,
  OAIMessageItem,
  OAIReasoningItem,
  OAISessionItem,
  OAISlashCommandItem,
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

/** A `command/run` event waiting for its `command/done`. */
export interface CommandRun {
  /** Position of the `command/run` event; names the item. */
  seq: number
  commandId: string
  name: string
  args?: string
}

/**
 * Pair a settled command with its run record.
 * @param run - the command's `command/run` data.
 * @param done - the command's `command/done` data.
 * @param turnId - open turn id, or `null` between turns.
 * @returns the saved item.
 */
export function slashCommandItem(
  run: CommandRun,
  done: { kind: 'success' | 'error'; text?: string },
  turnId: string | null,
): OAISlashCommandItem {
  const args = run.args?.trim()
  return {
    id: `item_cmd_${String(run.seq)}`,
    type: 'slash_command',
    command_id: run.commandId,
    name: run.name,
    ...(args === undefined || args === '' ? {} : { args }),
    status: done.kind === 'success' ? 'completed' : 'failed',
    ...(done.text === undefined ? {} : { text: done.text }),
    turn_id: turnId,
  }
}

/**
 * Content parts of a user message the client sent: the typed text, then one part per image or file block.
 * The agent-facing attachment note is not part of what the user typed and is left out.
 * @param content - logged message content.
 * @returns parts; a plain message keeps exactly one `input_text` part, an attachment-only message has none.
 */
function userContentParts(content: unknown): Array<OAIMessageItem['content'][number]> {
  if (!Array.isArray(content)) return [{ type: 'input_text', text: textFromContent(content) }]
  const typed = content.filter((block: unknown) => {
    const rec = block as { type?: unknown; text?: unknown }
    return !(rec?.type === 'text' && typeof rec.text === 'string' && rec.text.startsWith(ATTACHMENT_NOTE_PREFIX))
  })
  const files: OAIInputFilePart[] = []
  for (const block of typed as Array<Record<string, any>>) {
    const attachment = block?.['attachment'] as { attachmentId?: string; name?: string; bytes?: number; mediaType?: string; width?: number; height?: number } | undefined
    if (attachment === undefined || typeof attachment.attachmentId !== 'string') continue
    const name = attachment.name ?? (block['type'] === 'image' ? 'image' : 'file')
    if (block['type'] === 'image') {
      files.push({
        type: 'input_image',
        filename: name,
        bytes: attachment.bytes ?? 0,
        media_type: attachment.mediaType ?? 'application/octet-stream',
        ...(attachment.width === undefined ? {} : { width: attachment.width }),
        ...(attachment.height === undefined ? {} : { height: attachment.height }),
        attachment_id: attachment.attachmentId,
      })
    } else if (block['type'] === 'file') {
      files.push({ type: 'input_file', filename: name, bytes: attachment.bytes ?? 0, media_type: typeFromExtension(name) ?? 'application/octet-stream', attachment_id: attachment.attachmentId })
    }
  }
  const text = textFromContent(typed.filter((block: unknown) => (block as { type?: unknown })?.type !== 'image' && (block as { type?: unknown })?.type !== 'file'))
  return files.length > 0 && text === '' ? files : [{ type: 'input_text', text }, ...files]
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
/** First streamed reasoning or text token of an assistant attempt, epoch ms. */
function firstTokenAt(stream: Array<{ type: string; time0?: number }> | undefined): number | undefined {
  let first: number | undefined
  for (const rec of stream ?? []) {
    if ((rec.type === 'reasoning-chunks' || rec.type === 'text-chunks' || rec.type === 'tool-call-chunks') && typeof rec.time0 === 'number') {
      first = first === undefined ? rec.time0 : Math.min(first, rec.time0)
    }
  }
  return first
}

/** What the projector knows beyond the event itself. */
export interface ItemContext {
  /** When the event's step started (its `step/start`), epoch ms; absent when not in the log. */
  stepStartedAt?: number
  /** Agents API session the items belong to (the parent for subagent items); names tool-result images. */
  sessionId?: string
}

export function itemsFromEvent(event: SessionEvent, turnId: string, context: ItemContext = {}): OAISessionItem[] {
  const step = typeof (event.data as { step?: unknown }).step === 'number' ? (event.data as { step: number }).step : undefined
  const stepField = step === undefined ? {} : { step }
  if (event.type === 'user/message') {
    const data = event.data as { content?: unknown; source?: { kind?: string } }
    if (data.source?.kind === 'schedule') return scheduledPromptItems(event.seq, textFromContent(data.content), turnId)
    // Workspace instructions and runtime snapshots are plugin input, not the client's message.
    if (data.source?.kind !== 'user') return []
    const item: OAIMessageItem = {
      id: `item_msg_${String(event.seq)}`,
      type: 'message',
      role: 'user',
      content: userContentParts(data.content),
      status: 'completed',
      turn_id: turnId,
      timing: { completed_at_ms: event.time },
    }
    return [item]
  }

  if (event.type === 'assistant/message') {
    const data = event.data as {
      message?: { content?: unknown }
      stream?: Array<{ type: string; texts?: string[]; time0?: number }>
      usage?: Parameters<typeof toOAIUsage>[0]
    }
    const items: OAISessionItem[] = []
    const firstToken = firstTokenAt(data.stream)
    const started = context.stepStartedAt ?? firstToken
    const timing = {
      ...(started === undefined ? {} : { started_at_ms: started }),
      ...(firstToken === undefined ? {} : { first_token_at_ms: firstToken }),
      completed_at_ms: event.time,
    }
    const usage = toOAIUsage(data.usage)
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
              ...stepField,
              timing,
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
      ...stepField,
      ...(usage === null ? {} : { usage }),
      timing,
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
        ...stepField,
        timing: { started_at_ms: event.time },
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
      ...stepField,
      timing: { started_at_ms: event.time },
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
      timing: { completed_at_ms: event.time },
    }
    const connect = isError ? undefined : connectRequestFrom(output)
    if (connect !== undefined) fnOutItem.connect_request = connect
    const images = outputImageParts(message?.content, context.sessionId)
    if (images.length > 0) fnOutItem.images = images
    return [fnOutItem]
  }

  return []
}
