/**
 * Mount Agents API `agent.instructions` onto the Host system prompt.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Section name for wire agent instructions on the agent scope. */
export const AGENTS_API_INSTRUCTIONS_SECTION = 'agents-api:instructions'

/**
 * Order after `deployment:persona-prefix` (0) and before plan/tool guidance
 * bands so API instructions act as the session persona.
 */
export const AGENTS_API_INSTRUCTIONS_ORDER = 10

/**
 * Register non-empty wire instructions as an agent-scoped system-prompt section.
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 * @param instructions - Agents API `agent.instructions` value.
 */
export function mountAgentInstructions(
  agentCtx: Context,
  instructions: string | null | undefined,
): void {
  if (instructions === undefined || instructions === null) return
  const text = instructions.trim()
  if (text.length === 0) return
  if (agentCtx.get('systemPrompt') === undefined) {
    throw new Error(
      'agent.instructions requires Host ctx.systemPrompt; use a base-backed agents profile',
    )
  }
  agentCtx.systemPrompt.section({
    name: AGENTS_API_INSTRUCTIONS_SECTION,
    order: AGENTS_API_INSTRUCTIONS_ORDER,
    text,
  })
}
