/**
 * Parse Agents API input payloads into Host values.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { OAIAgent, OAIInputMessage, OAITokenUsage, SessionAgentParams } from './types.ts'

/**
 * Flatten create-session or input-event payloads into one user prompt.
 * @param input - string or input-message array from the wire.
 * @returns concatenated text, or `undefined` when no text is present.
 */
export function userTextFromInput(input: string | OAIInputMessage[] | undefined): string | undefined {
  if (input === undefined) return undefined
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return JSON.stringify(input)
  const text = input
    .flatMap(message => message.content ?? [])
    .filter((part): part is { type: 'input_text'; text: string } => part.type === 'input_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
  return text
}

/**
 * Parse a `tool/call` arguments payload. The Session log stores the model's
 * raw JSON string; recovered objects are kept as records.
 * @param raw - Session `arguments` value.
 * @returns an object suitable for `function_call.arguments`.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return { raw }
    } catch {
      return { raw }
    }
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}

/**
 * Join model-facing content blocks into one string.
 * @param content - string, content-block array, or unknown JSON.
 * @returns concatenated text, or a JSON serialization of non-text values.
 */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content == null) return ''
    return JSON.stringify(content)
  }
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const rec = block as Record<string, unknown>
    if (typeof rec.text === 'string') {
      parts.push(rec.text)
      continue
    }
    if (rec.type === 'tool-result' && Array.isArray(rec.content)) {
      parts.push(textFromContent(rec.content))
    }
  }
  return parts.join('')
}

/**
 * Overlay session-create `agent` fields onto a saved agent. Supplied objects
 * and arrays replace the field; omitted fields keep the saved value.
 * @param base - saved agent copied into the session.
 * @param overlay - session-local overrides.
 * @returns a session-local agent configuration.
 */
export function overlayAgent(base: OAIAgent, overlay: SessionAgentParams): OAIAgent {
  return {
    ...base,
    ...(overlay.model !== undefined ? { model: overlay.model } : {}),
    name: overlay.name !== undefined ? overlay.name : base.name,
    instructions: overlay.instructions !== undefined ? overlay.instructions : base.instructions,
    metadata: overlay.metadata === undefined ? base.metadata : (overlay.metadata ?? {}),
    tools: overlay.tools === undefined ? base.tools : (overlay.tools ?? []),
    ...(overlay.host_tools !== undefined ? { host_tools: overlay.host_tools } : {}),
    ...(overlay.multi_agent !== undefined ? { multi_agent: overlay.multi_agent } : {}),
    ...(overlay.reasoning !== undefined ? { reasoning: overlay.reasoning } : {}),
    ...(overlay.service_tier !== undefined ? { service_tier: overlay.service_tier } : {}),
    ...(overlay.text !== undefined ? { text: overlay.text } : {}),
  }
}

/**
 * Project DSH token usage onto the Agents API usage object.
 * @param usage - Session or turn usage, when recorded.
 * @returns wire usage, or `null` when unknown.
 */
export function toOAIUsage(usage: TokenUsage | undefined): OAITokenUsage | null {
  if (usage === undefined) return null
  const cached = usage.cacheReadTokens ?? 0
  const reasoning = usage.reasoningTokens ?? 0
  const input = usage.inputTokens + cached + (usage.cacheWriteTokens ?? 0)
  const output = usage.outputTokens
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: usage.totalTokens ?? input + output,
  }
}
