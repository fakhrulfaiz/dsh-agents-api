/**
 * System-prompt guidance for scheduled tasks the agent creates from a chat.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Section name for the Agentry scheduling guidance on the agent scope. */
export const AGENTRY_SCHEDULE_SECTION = 'agentry:schedule'

/** Tool whose visibility to the agent switches the guidance on. */
const SCHEDULE_CREATE_TOOL = 'schedule_create'

/** Guidance shown while `schedule_create` is visible. */
export const AGENTRY_SCHEDULE_GUIDANCE = [
  'Scheduled tasks in this deployment:',
  '- Always create a task with target `this_session`. Never use `new_once` or `new`: the sessions they create are not visible to the user.',
  '- Use the time zone the user stated in this conversation. If none was stated, ask for it before creating the task.',
].join('\n')

/**
 * Register the scheduling guidance as an agent-scoped system-prompt section
 * placed just after `tool:schedule`. The text is empty at each prompt assembly
 * where the agent cannot see `schedule_create`, so profiles without the
 * schedule tools and agents whose `host_tools` hide it get no section text.
 * A Host without `ctx.systemPrompt` gets no section.
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 */
export function mountScheduleGuidance(agentCtx: Context): void {
  if (agentCtx.get('systemPrompt') === undefined) return
  agentCtx.systemPrompt.section({
    name: AGENTRY_SCHEDULE_SECTION,
    order: agentCtx.systemPrompt.getSectionOrder('TOOL_SCHEDULE') + 1,
    text: ({ scope }) => agentCtx.tools.get(SCHEDULE_CREATE_TOOL, scope) === undefined ? '' : AGENTRY_SCHEDULE_GUIDANCE,
  })
}
