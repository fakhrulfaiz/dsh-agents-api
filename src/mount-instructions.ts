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

/** Section name for the always-on workspace and shell guidance. */
export const AGENTS_API_GUIDANCE_SECTION = 'agents-api:workspace-guidance'

/** Orders the guidance directly after the wire instructions. */
export const AGENTS_API_GUIDANCE_ORDER = 11

/** Rules that keep shell use inside the workspace and office work on skill scripts. */
export const AGENTS_API_GUIDANCE_TEXT = [
  'Do not search the whole filesystem (`/`, `/mnt`, or a home-wide `find`); stay inside the workspace.',
  "For office files (docx, pptx, xlsx), use the matching office skill's own scripts instead of looking for Python or Node libraries.",
].join('\n')

/**
 * Register non-empty wire instructions as an agent-scoped system-prompt section.
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 * @param instructions - Agents API `agent.instructions` value.
 */
export function mountAgentInstructions(
  agentCtx: Context,
  instructions: string | null | undefined,
): void {
  const text = instructions?.trim() ?? ''
  if (agentCtx.get('systemPrompt') === undefined) {
    if (text.length === 0) return
    throw new Error(
      'agent.instructions requires Host ctx.systemPrompt; use a base-backed agents profile',
    )
  }
  if (text.length > 0) {
    agentCtx.systemPrompt.section({
      name: AGENTS_API_INSTRUCTIONS_SECTION,
      order: AGENTS_API_INSTRUCTIONS_ORDER,
      text,
    })
  }
  agentCtx.systemPrompt.section({
    name: AGENTS_API_GUIDANCE_SECTION,
    order: AGENTS_API_GUIDANCE_ORDER,
    text: AGENTS_API_GUIDANCE_TEXT,
  })
}
