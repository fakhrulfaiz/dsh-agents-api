/**
 * Saved-agent create and update shared by the model-facing agent tools. It
 * calls the same validators and record helpers as the `/agents` routes, so
 * both paths accept and reject the same input.
 */

import { materializeAgent, updatedAgent } from './agent-records.ts'
import type { OwnerId } from './auth/authenticator.ts'
import { AGENT_COLOR_NAMES, AGENT_ICON_NAMES } from './agent-avatar.ts'
import { validateAppGrants } from './composio-grants.ts'
import { validateHostTools } from './host-tools.ts'
import { validateMountableTools } from './mount-function-tools.ts'
import type { Store } from './store/store.ts'
import type { AgentSkillSelection, CreateAgentParams, OAIAgent, UpdateAgentParams } from './types.ts'

/** Most saved agents one owner may have. */
export const AGENT_LIMIT = 100
export const NAME_MAX = 80
export const INSTRUCTIONS_MAX = 20_000
export const MAX_SUBAGENTS = 8
/** Tools that write agents; a created agent never gets them unless the owner's agent already allowed them. */
export const AGENT_WRITE_TOOLS = ['agent_create', 'agent_update'] as const
const APP_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** What the model may set on an agent. Wire tools, credentials and URLs are deliberately absent. */
export interface AgentInput {
  name: string
  instructions?: string
  model?: string
  /** Host tool names to allow; must be tools the calling session can see. */
  toolsAllow?: string[]
  /** Most subagents at once; absent leaves subagents as they are. */
  subagents?: number
  /** Composio app slugs the agent may use (each with all its tools); clamped to the caller's own grant. */
  apps?: string[]
  /** Avatar icon name (`AGENT_ICON_NAMES`), saved as `metadata.icon`. */
  icon?: string
  /** Avatar colour (`AGENT_COLOR_NAMES`), saved as `metadata.color`. */
  color?: string
  /** Skill selection; checked against the built-ins and the owner's library by the caller. */
  skills?: AgentSkillSelection
}

/** A rejected input, with a message the model can act on. */
export class AgentInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentInputError'
  }
}

/**
 * @param input - fields from a tool call; absent fields are not checked.
 * @param visibleTools - Host tool names the calling session can see.
 * @returns an error message, or `undefined` when the input is valid.
 */
export function validateAgentInput(input: Partial<AgentInput>, visibleTools: ReadonlySet<string>): string | undefined {
  const { name, instructions, toolsAllow, apps, subagents, icon, color } = input
  if (icon !== undefined && !AGENT_ICON_NAMES.includes(icon)) return `icon must be one of: ${AGENT_ICON_NAMES.join(', ')}`
  if (color !== undefined && !AGENT_COLOR_NAMES.includes(color)) return `color must be one of: ${AGENT_COLOR_NAMES.join(', ')}`
  if (name !== undefined && (name.trim() === '' || name.length > NAME_MAX)) return `name must be 1 to ${NAME_MAX} characters`
  if (instructions !== undefined && instructions.length > INSTRUCTIONS_MAX) return `instructions must be at most ${INSTRUCTIONS_MAX} characters`
  for (const tool of toolsAllow ?? []) {
    if (tool.startsWith('agent_')) return `${tool} cannot be given to an agent`
    if (!visibleTools.has(tool)) return `${tool} is not a tool available in this chat; call agent_tools to see the choices`
  }
  for (const app of apps ?? []) if (!APP_SLUG.test(app)) return `app "${app}" is not a valid app name (lowercase letters, digits, _ or -)`
  if (subagents !== undefined && (!Number.isInteger(subagents) || subagents < 1 || subagents > MAX_SUBAGENTS)) {
    return `subagents must be a whole number from 1 to ${MAX_SUBAGENTS}`
  }
  return undefined
}

/**
 * Map tool input to agent fields. With `existing`, fields the input does not mention keep their values.
 * @param input - validated input with the model already resolved by the caller.
 * @param existing - the stored agent being updated.
 */
export function toAgentParams(input: AgentInput & { model: string }, existing?: OAIAgent): CreateAgentParams {
  const allowed = existing?.host_tools?.allow ?? []
  const deny = [...new Set([...(existing?.host_tools?.deny ?? []), ...AGENT_WRITE_TOOLS.filter((t) => !allowed.includes(t))])]
  const allow = input.toolsAllow !== undefined && input.toolsAllow.length > 0 ? input.toolsAllow : existing?.host_tools?.allow
  const metadata = { ...existing?.metadata }
  // Grants replace the legacy `metadata.connectors` hint.
  if (input.apps !== undefined) delete metadata.connectors
  if (input.icon !== undefined) metadata.icon = input.icon
  if (input.color !== undefined) metadata.color = input.color
  const multi = input.subagents !== undefined ? { enabled: true, max_concurrent_subagents: input.subagents } : existing?.multi_agent
  return {
    model: input.model,
    name: input.name,
    instructions: input.instructions ?? existing?.instructions ?? null,
    metadata,
    host_tools: { ...(allow && allow.length > 0 ? { allow } : {}), deny },
    ...(input.apps !== undefined ? { apps: Object.fromEntries(input.apps.map(slug => [slug, 'all' as const])) } : {}),
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
    ...(multi ? { multi_agent: multi } : {}),
  }
}

function check(params: CreateAgentParams | UpdateAgentParams): void {
  const toolError = params.tools != null ? validateMountableTools(params.tools) : undefined
  if (toolError) throw new AgentInputError(toolError)
  const appsError = validateAppGrants(params.apps)
  if (appsError) throw new AgentInputError(appsError)
  const hostError = validateHostTools(params.host_tools)
  if (hostError) throw new AgentInputError(hostError)
}

/** @throws AgentInputError when the owner is at the limit or a field is invalid. */
export async function createSavedAgent(store: Store, owner: OwnerId, params: CreateAgentParams): Promise<OAIAgent> {
  check(params)
  const page = await store.agents.list(owner, { limit: AGENT_LIMIT })
  if (page.data.length >= AGENT_LIMIT || page.has_more) throw new AgentInputError(`agent limit reached (${AGENT_LIMIT}); delete one on the Agents page first`)
  return store.agents.create(owner, materializeAgent(params))
}

/** @returns the updated agent, or `undefined` when the owner has no such agent. */
export async function updateSavedAgent(store: Store, owner: OwnerId, id: string, params: UpdateAgentParams): Promise<OAIAgent | undefined> {
  check(params)
  const existing = await store.agents.get(owner, id)
  return existing === undefined ? undefined : store.agents.update(owner, id, updatedAgent(existing, params))
}
