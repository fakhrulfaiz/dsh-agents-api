/**
 * Model-facing tools that look up and manage the owner's saved agents:
 * `agent_tools`, `agent_list`, `agent_get`, `agent_create`, `agent_update`.
 * Registered on each session's agent scope; every call is scoped to the
 * session owner, writes ask the user first, and the input has no way to attach
 * wire tools, credentials or URLs.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  AgentInputError,
  createSavedAgent,
  INSTRUCTIONS_MAX,
  MAX_SUBAGENTS,
  NAME_MAX,
  toAgentParams,
  updateSavedAgent,
  validateAgentInput,
  type AgentInput,
} from './agent-service.ts'
import type { OwnerId } from './auth/authenticator.ts'
import type { Store } from './store/store.ts'
import { AGENT_COLOR_NAMES, AGENT_ICON_NAMES } from './agent-avatar.ts'
import { clampGrants, effectiveGrants } from './composio-grants.ts'
import type { AgentAppGrants, OAIAgent } from './types.ts'

export interface AgentToolsDeps {
  owner: OwnerId
  store: Store
  /** The session's model, used when a created agent names none. */
  defaultModel: string
  /** Returns an error message when `model` cannot be used. Absent: any model is accepted. */
  checkModel?: (model: string) => Promise<string | undefined>
  /**
   * The tools the session's agent can really call. `agent` is the agent a tool call runs for: its scope
   * holds the preset's tools plus this session's own (MCP and wire function tools). Without it, the
   * default preset's catalog. Absent: this agent scope's own registry.
   */
  listTools?: (agent?: unknown) => Promise<{ name: string; description?: string }[]>
  /** The calling agent's app grants; created and updated agents never get more. Absent or `null`: unrestricted. */
  callerGrants?: AgentAppGrants | null
  /** Built-in skill names a selection may name. */
  builtinSkills?: () => ReadonlySet<string>
}

export const AGENT_TOOL_NAMES = ['agent_tools', 'agent_list', 'agent_get', 'agent_create', 'agent_update'] as const
const WRITE_TOOLS = new Set<string>(['agent_create', 'agent_update'])
const MCP_NAME = /^mcp__(.+?)__(.+)$/

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
})

const editable = {
  instructions: { type: 'string', maxLength: INSTRUCTIONS_MAX, description: 'The agent\'s brief: role, how to work, boundaries, output.' },
  model: { type: 'string', description: 'Model name. Omit to use this chat\'s model.' },
  tools_allow: { type: 'array', items: { type: 'string' }, description: 'Host tool names the agent may use; from agent_tools. Omit to leave tools unchanged.' },
  subagents: { type: 'integer', minimum: 1, maximum: MAX_SUBAGENTS, description: 'Most subagents at once. Omit for none.' },
  apps: { type: 'array', items: { type: 'string' }, description: 'Connected app names the agent may use, such as gmail. Limited to the apps this chat may use. An empty list allows none.' },
  icon: { type: 'string', enum: [...AGENT_ICON_NAMES], description: 'Avatar icon that fits the agent\'s job. Pick one when creating an agent.' },
  color: { type: 'string', enum: [...AGENT_COLOR_NAMES], description: 'Avatar colour.' },
  skills: {
    type: 'object',
    description: 'Skills the agent uses: built-in names and library skill ids. Omit to keep the default (all built-ins).',
    properties: { builtin: { type: 'array', items: { type: 'string' } }, library: { type: 'array', items: { type: 'string' } } },
    required: ['builtin', 'library'],
    additionalProperties: false,
  },
}

const summary = (a: OAIAgent) => ({
  id: a.id,
  name: a.name,
  model: a.model,
  summary: (a.instructions ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? '',
})

interface Args {
  [key: string]: unknown
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined)

function inputFrom(args: Args): Partial<AgentInput> {
  const input: Partial<AgentInput> = {}
  const name = str(args.name)
  const instructions = str(args.instructions)
  const model = str(args.model)
  const toolsAllow = strs(args.tools_allow)
  const apps = strs(args.apps)
  if (name !== undefined) input.name = name
  if (instructions !== undefined) input.instructions = instructions
  if (model !== undefined) input.model = model
  if (toolsAllow !== undefined) input.toolsAllow = toolsAllow
  if (typeof args.subagents === 'number') input.subagents = args.subagents
  if (apps !== undefined) input.apps = apps
  const icon = str(args.icon)
  const color = str(args.color)
  if (icon !== undefined) input.icon = icon
  if (color !== undefined) input.color = color
  const skills = args.skills as { builtin?: unknown; library?: unknown } | undefined
  const builtin = strs(skills?.builtin)
  const library = strs(skills?.library)
  if (builtin !== undefined && library !== undefined) input.skills = { builtin, library }
  return input
}

/** `agent` is the agent the call runs for, the scope whose tools it can really use. */
function tool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Args, agent?: unknown) => Promise<unknown>): ToolDefinition {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render(_args: unknown, value: unknown) {
        return [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
    },
    async execute(args: unknown, exec?: { agent?: unknown }) {
      try {
        return JSON.stringify(await run((args ?? {}) as Args, exec?.agent))
      } catch (error) {
        if (error instanceof AgentInputError) return JSON.stringify({ error: error.message })
        throw error
      }
    },
  } as ToolDefinition
}

/**
 * Register the agent tools and the approval handler on an agent scope.
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 * @param deps - the session owner, store and model helpers.
 */
export function mountAgentTools(agentCtx: Context, deps: AgentToolsDeps): void {
  const { owner, store } = deps
  const schemas = async (agent?: unknown) => {
    const all = (await (deps.listTools?.(agent) ?? agentCtx.tools.schemas(agent as never))) as { name: string; description?: string }[]
    return all.filter((s) => !s.name.startsWith('agent_'))
  }
  const notFound = (id: unknown) => ({ error: `no agent with id ${String(id)}` })

  const resolveInput = async (args: Args, agent: unknown, existing?: OAIAgent): Promise<AgentInput & { model: string } | { error: string }> => {
    const input = inputFrom(args)
    const error = validateAgentInput(input, new Set((await schemas(agent)).map((s) => s.name)))
    if (error) return { error }
    if (input.skills !== undefined) {
      const builtins = deps.builtinSkills?.() ?? new Set<string>()
      const bad = input.skills.builtin.find(name => !builtins.has(name))
      if (bad !== undefined) return { error: `skills.builtin: "${bad}" is not a built-in skill` }
      for (const id of input.skills.library) {
        const row = await store.skills.get(id, owner)
        if (row === undefined || row.scope !== 'library') return { error: `skills.library: "${id}" is not one of your library skills` }
      }
    }
    const model = input.model ?? existing?.model ?? deps.defaultModel
    const modelError = input.model !== undefined && deps.checkModel ? await deps.checkModel(input.model) : undefined
    if (modelError) return { error: modelError }
    return { ...input, name: input.name ?? existing?.name ?? '', model }
  }

  const tools: ToolDefinition[] = [
    tool(
      'agent_tools',
      'List the tools this chat can use and the MCP servers behind some of them, so you can choose what a new agent may use.',
      object({}),
      async (_args, agent) => {
        const all = await schemas(agent)
        const servers = new Map<string, string[]>()
        for (const { name } of all) {
          const m = MCP_NAME.exec(name)
          const server = m?.[1]
          const toolName = m?.[2]
          if (server && toolName) servers.set(server, [...(servers.get(server) ?? []), toolName])
        }
        return {
          tools: all.map((s) => ({ name: s.name, description: (s.description ?? '').slice(0, 200) })),
          mcp_servers: [...servers].map(([server, names]) => ({ server, tool_count: names.length, sample: names.slice(0, 3) })),
        }
      },
    ),
    tool('agent_list', 'List the user\'s saved agents.', object({ limit: { type: 'integer', minimum: 1, maximum: 100 } }), async (args) => {
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 100) : 20
      const page = await store.agents.list(owner, { limit })
      return { agents: page.data.map(summary), has_more: page.has_more }
    }),
    tool('agent_get', 'Read one saved agent in full.', object({ id: { type: 'string' } }, ['id']), async (args) => {
      const agent = await store.agents.get(owner, String(args.id ?? ''))
      if (!agent) return notFound(args.id)
      return {
        id: agent.id,
        name: agent.name,
        model: agent.model,
        instructions: agent.instructions,
        host_tools: agent.host_tools ?? null,
        multi_agent: agent.multi_agent ?? null,
        apps: effectiveGrants(agent),
        skills: agent.skills ?? null,
      }
    }),
    tool(
      'agent_create',
      'Save a new agent. The user is asked to approve it. Show the draft and get the user\'s yes before calling this.',
      object({ name: { type: 'string', minLength: 1, maxLength: NAME_MAX }, ...editable }, ['name']),
      async (args, scope) => {
        const input = await resolveInput(args, scope)
        if ('error' in input) return input
        const params = toAgentParams(input)
        params.apps = clampGrants(params.apps ?? null, deps.callerGrants ?? null)
        const created = await createSavedAgent(store, owner, params)
        return { id: created.id, name: created.name }
      },
    ),
    tool(
      'agent_update',
      'Change a saved agent. The user is asked to approve it. Send only the fields that change.',
      object({ id: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: NAME_MAX }, ...editable }, ['id']),
      async (args, agent) => {
        const existing = await store.agents.get(owner, String(args.id ?? ''))
        if (!existing) return notFound(args.id)
        const input = await resolveInput(args, agent, existing)
        if ('error' in input) return input
        const params = toAgentParams(input, existing)
        if (params.apps !== undefined) params.apps = clampGrants(params.apps, deps.callerGrants ?? null)
        const updated = await updateSavedAgent(store, owner, existing.id, params)
        return updated ? { id: updated.id, name: updated.name } : notFound(args.id)
      },
    ),
  ]
  for (const definition of tools) agentCtx.tools.register(definition)

  // Writes need the user's approval; the Agents API approval bridge turns this into a required action.
  // The agent scope of a live session always has `on`; a bare test double may not.
  if (typeof (agentCtx as { on?: unknown }).on !== 'function') return
  const approve = async (exec: { name: string; arguments: unknown }, next: () => Promise<unknown>): Promise<unknown> => {
    if (!WRITE_TOOLS.has(exec.name)) return next()
    const args = (exec.arguments ?? {}) as Args
    const label = exec.name === 'agent_create' ? 'Create agent' : 'Update agent'
    const excerpt = (str(args.instructions) ?? '').replace(/\s+/g, ' ').slice(0, 200)
    const text = `${label} "${str(args.name) ?? str(args.id) ?? ''}"${excerpt ? `: ${excerpt}` : ''}`
    return { kind: 'ask' as const, reason: text, displayReason: { en: text } }
  }
  agentCtx.on('tools/pre-execute', approve as never)
}
