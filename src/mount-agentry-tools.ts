/**
 * Model-facing tools for the rest of Agentry, so an agent can set things up for the user:
 *
 * - Projects: `project_list`, `project_create`, `project_update`, `chat_move_to_project`.
 * - The agent Library: `library_search` (built-ins and the owner's sources), `library_add` (saves an agent from
 *   one entry, named like the web app's Add: "Name (Source)" when the name is taken).
 * - Environments: `environment_list` (every named environment with its live state). Templates, creating and
 *   starting sandboxes are the `sandbox_*` tools; saved agents are the `agent_*` tools; schedules `schedule_*`.
 *
 * Registered on each session's agent scope before the `host_tools` mask, so an agent's mask can hide them.
 * Every call is scoped to the session owner and goes through the same helpers as the HTTP routes
 * (`projects.ts`, `agent-service.ts`, the Library). Creating or changing anything asks the user first
 * (`tools/pre-execute` answers `ask`, which the approval bridge turns into an approval card); reads never ask.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AgentInputError, createSavedAgent } from './agent-service.ts'
import type { ImportCandidate } from './agent-import/fetch.ts'
import type { BuiltinLibraryItem } from './agent-import/builtin-library.ts'
import { nameForAdd, refOf } from './agent-import/builtin-library.ts'
import { ImportError, titleFromSlug, type AgentDraft } from './agent-import/parse.ts'
import type { OwnerId } from './auth/authenticator.ts'
import { clampGrants } from './composio-grants.ts'
import type { SdkEnvironment } from './environment/environment-compat.ts'
import type { EnvironmentRecord } from './environment-types.ts'
import { AgentsApiRequestError } from './errors.ts'
import { createProject, parseProjectInput, updateProject } from './projects.ts'
import type { LibrarySource, Store } from './store/store.ts'
import type { AgentAppGrants, CreateAgentParams, OAIProject } from './types.ts'

export interface AgentryToolsDeps {
  owner: OwnerId
  store: Store
  /** This chat; `chat_move_to_project` moves it when no `session_id` is given. */
  sessionId: string
  /** The model an added agent gets (this chat's model). */
  defaultModel: string
  /** The calling agent's app grants; added agents never get more. Absent or `null`: unrestricted. */
  callerGrants?: AgentAppGrants | null
  /** Built-in agent ids a project may name besides the owner's saved agents. */
  builtinAgentIds?: ReadonlySet<string>
  library: {
    /** The built-in Library. */
    builtin(): Promise<BuiltinLibraryItem[]>
    /** The owner's sources and their agent files; a source that cannot be read has `error`. */
    sources(owner: OwnerId): Promise<Array<{ source: LibrarySource; candidates: ImportCandidate[]; error?: string }>>
    /** A source file's agent draft (fetched and parsed like `POST /agents/import`). */
    draft(url: string): Promise<AgentDraft>
  }
  /** The wire form of an environment, with its live state. */
  describe(record: EnvironmentRecord): Promise<SdkEnvironment>
  /**
   * Move one of the owner's chats into a project (`null`: out of any), like `POST /agents/sessions/{id}`.
   * @returns false when the owner has no such chat.
   * @throws AgentsApiRequestError for a missing or archived project.
   */
  moveChat(sessionId: string, projectId: string | null): Promise<boolean>
  /** Also ask before `schedule_create` and `schedule_edit` (DSH's own tools never ask); on for the built-in assistant. */
  askSchedules?: boolean
}

export const AGENTRY_TOOL_NAMES = ['project_list', 'project_create', 'project_update', 'chat_move_to_project', 'library_search', 'library_add', 'environment_list'] as const
const ASK_TOOLS = new Set<string>(['project_create', 'project_update', 'chat_move_to_project', 'library_add'])
const SCHEDULE_ASK_TOOLS = new Set<string>(['schedule_create', 'schedule_edit'])
const SEARCH_MAX = 30

type Args = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/** A refusal the model should read (unknown id, bad input), as opposed to a crash. */
class ToolRefusal extends Error {}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false,
})

function tool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Args) => Promise<unknown>): ToolDefinition {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args: unknown) {
      try {
        return JSON.stringify(await run((args ?? {}) as Args))
      } catch (error) {
        if (error instanceof ToolRefusal || error instanceof AgentInputError || error instanceof AgentsApiRequestError || error instanceof ImportError) {
          return JSON.stringify({ error: error.message })
        }
        throw error
      }
    },
  } as ToolDefinition
}

const projectSummary = (p: OAIProject) => {
  const env = p.environment as { environment_id?: unknown; directory?: unknown } | null
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    pinned: p.pinned,
    agent_id: p.agent_id,
    environment_id: typeof env?.environment_id === 'string' ? env.environment_id : null,
    directory: typeof env?.directory === 'string' ? env.directory : null,
    link: `/?project=${p.id}`,
  }
}

/** How many words of `query` appear in the item's name, slug or description (case-insensitive). */
function score(query: string, ...fields: string[]): number {
  const text = fields.join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/u).filter(Boolean).filter(word => text.includes(word)).length
}

/**
 * Register the Agentry tools and their approval handler on an agent scope.
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 * @param deps - the session owner, store and the shared helpers.
 */
export function mountAgentryTools(agentCtx: Context, deps: AgentryToolsDeps): void {
  const { owner, store } = deps

  async function environmentRecord(id: unknown): Promise<EnvironmentRecord> {
    const record = typeof id === 'string' ? await store.environments.get(owner, id) : undefined
    if (!record) throw new ToolRefusal(`no environment "${String(id)}"; call environment_list for the user's environments`)
    return record
  }

  async function checkAgent(id: string): Promise<void> {
    if (deps.builtinAgentIds?.has(id)) return
    if (!await store.agents.get(owner, id)) throw new ToolRefusal(`no agent "${id}"; call agent_list for the user's agents`)
  }

  async function project(id: unknown): Promise<OAIProject> {
    const found = typeof id === 'string' ? await store.projects.get(owner, id) : undefined
    if (!found) throw new ToolRefusal(`no project "${String(id)}"; call project_list for the user's projects`)
    return found
  }

  /** The project body fields a create or update call sets; `existing` keeps the environment for a folder-only change. */
  async function projectBody(args: Args, existing?: OAIProject): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {}
    if (args.name !== undefined) body.name = args.name
    if (args.pinned !== undefined) body.pinned = args.pinned
    if (args.agent_id === null) body.agent_id = null
    else if (str(args.agent_id)) {
      await checkAgent(str(args.agent_id)!)
      body.agent_id = str(args.agent_id)
    }
    const current = existing?.environment as { environment_id?: string; directory?: string } | null | undefined
    const environmentId = args.environment_id === null ? null : str(args.environment_id) ?? current?.environment_id
    if (args.environment_id === null) {
      body.environment = null
    } else if (args.environment_id !== undefined || args.directory !== undefined) {
      if (environmentId === undefined) throw new ToolRefusal('a folder needs an environment; give environment_id too')
      await environmentRecord(environmentId)
      const directory = args.directory === null ? undefined : str(args.directory) ?? (args.environment_id === undefined ? current?.directory : undefined)
      body.environment = { type: 'sandbox', environment_id: environmentId, ...(directory ? { directory } : {}) }
    }
    return body
  }

  async function allEnvironments(): Promise<EnvironmentRecord[]> {
    const out: EnvironmentRecord[] = []
    let after: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const res = await store.environments.list(owner, { limit: 100, ...(after ? { after } : {}) })
      out.push(...res.data)
      if (!res.has_more || !res.last_id) break
      after = res.last_id
    }
    return out
  }

  async function savedNames(): Promise<string[]> {
    return (await store.agents.list(owner, { limit: 100 })).data.map(a => a.name ?? '')
  }

  const projectFields = {
    agent_id: { type: ['string', 'null'], description: 'Agent new chats in the project use: an id from agent_list, library_add or agent_create. null clears it (the default agent).' },
    environment_id: { type: ['string', 'null'], description: 'Environment new chats in the project run in: an id from environment_list or sandbox_create. null clears it (this server).' },
    directory: { type: ['string', 'null'], description: 'Starting folder inside the environment\'s workspace, a relative path such as "recipe-site". Created when the first chat starts. Needs environment_id.' },
    pinned: { type: 'boolean', description: 'Pin the project at the top of the sidebar.' },
  }

  const tools: ToolDefinition[] = [
    tool('project_list', 'List the user\'s projects (active ones unless status says otherwise), with each project\'s agent, environment, folder and link.',
      object({ status: { type: 'string', enum: ['active', 'archived', 'all'] } }),
      async (args) => {
        const status = args.status === 'archived' || args.status === 'all' ? args.status : 'active'
        const page = await store.projects.list({ owner, status, limit: 100 })
        return { projects: page.data.map(projectSummary), has_more: page.has_more }
      }),

    tool('project_create', 'Create a project: a named group of chats with a default agent, environment and starting folder. The user is asked to approve it. Propose it and get the user\'s yes before calling this.',
      object({ name: { type: 'string', minLength: 1, maxLength: 80 }, ...projectFields }, ['name']),
      async (args) => {
        const parsed = parseProjectInput(await projectBody(args), false)
        if ('error' in parsed) throw new ToolRefusal(parsed.error)
        return projectSummary(await createProject(store, owner, parsed.value))
      }),

    tool('project_update', 'Change a project\'s name, agent, environment, folder or pin. The user is asked to approve it. Send only the fields that change.',
      object({ id: { type: 'string', description: 'A project id from project_list.' }, name: { type: 'string', minLength: 1, maxLength: 80 }, ...projectFields }, ['id']),
      async (args) => {
        const existing = await project(args.id)
        const parsed = parseProjectInput(await projectBody(args, existing), true)
        if ('error' in parsed) throw new ToolRefusal(parsed.error)
        const updated = await updateProject(store, owner, existing, parsed.value)
        if (!updated) throw new ToolRefusal(`no project "${existing.id}"`)
        return projectSummary(updated)
      }),

    tool('chat_move_to_project', 'Move a chat into a project (or out of any with project_id null). Moves this chat unless session_id names another of the user\'s chats. The user is asked to approve it. The chat keeps its agent and environment.',
      object({
        project_id: { type: ['string', 'null'], description: 'A project id from project_list or project_create; null takes the chat out of its project.' },
        session_id: { type: 'string', description: 'Another chat\'s id. Omit for this chat.' },
      }, ['project_id']),
      async (args) => {
        const sessionId = str(args.session_id) ?? deps.sessionId
        const projectId = args.project_id === null ? null : str(args.project_id)
        if (projectId === undefined) throw new ToolRefusal('project_id is required (null to take the chat out of its project)')
        if (projectId !== null) await project(projectId)
        if (!await deps.moveChat(sessionId, projectId)) throw new ToolRefusal(`no chat "${sessionId}"`)
        return { session_id: sessionId, project_id: projectId, ...(projectId ? { link: `/?project=${projectId}` } : {}) }
      }),

    tool('library_search', 'Search the agent Library: Agentry\'s built-in agents (a planner, code reviewers, a marketing agent, ...) and the user\'s own Library sources. Returns each entry\'s ref for library_add. Omit query to list everything.',
      object({ query: { type: 'string', description: 'Words to match in the name or description, such as "frontend" or "review".' } }),
      async (args) => {
        const query = str(args.query) ?? ''
        const added = new Set((await store.agents.list(owner, { limit: 100 })).data.map(a => a.metadata?.['library_ref']).filter(Boolean))
        const builtin = (await deps.library.builtin()).map(i => ({ ref: i.ref, name: i.name, source: i.source, description: i.description, slug: i.slug }))
        const sources = await deps.library.sources(owner)
        const remote = sources.flatMap(({ source, candidates }) => candidates.map(c => ({ ref: refOf(source.label, c.url), name: titleFromSlug(c.name), source: source.label, description: c.description, slug: c.name })))
        // Best matches first: entries matching more of the words, then Library order.
        const hits = query === ''
          ? [...builtin, ...remote]
          : [...builtin, ...remote].map(i => ({ i, n: score(query, i.name, i.slug, i.description) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).map(x => x.i)
        return {
          agents: hits.slice(0, SEARCH_MAX).map(({ slug: _slug, ...i }) => ({ ...i, description: i.description.slice(0, 200), ...(added.has(i.ref) ? { already_added: true } : {}) })),
          ...(hits.length > SEARCH_MAX ? { more: hits.length - SEARCH_MAX } : {}),
          ...(sources.some(s => s.error) ? { unreadable_sources: sources.filter(s => s.error).map(s => s.source.label) } : {}),
        }
      }),

    tool('library_add', 'Save an agent from a Library entry (a ref from library_search) to the user\'s agents. The user is asked to approve it. If the name is taken the agent is named "Name (Source)". Returns the new agent\'s id for project_create.',
      object({
        ref: { type: 'string', description: 'The entry\'s ref from library_search.' },
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'A different name. Omit to keep the Library name.' },
      }, ['ref']),
      async (args) => {
        const ref = str(args.ref)
        if (!ref) throw new ToolRefusal('ref is required; call library_search first')
        let draft: AgentDraft
        let label: string
        const builtin = (await deps.library.builtin()).find(i => i.ref === ref)
        if (builtin) {
          draft = builtin.draft
          label = builtin.source
        } else {
          const found = (await deps.library.sources(owner)).flatMap(({ source, candidates }) => candidates.map(c => ({ label: source.label, url: c.url }))).find(c => refOf(c.label, c.url) === ref)
          if (!found) throw new ToolRefusal(`no Library entry "${ref}"; call library_search for the refs`)
          draft = await deps.library.draft(found.url)
          label = found.label
        }
        const name = nameForAdd(str(args.name) ?? draft.name ?? 'Agent', label, await savedNames())
        // Wire tools (MCP servers with URLs and keys) are never added by a model; the user can add them on the Agents page.
        const params: CreateAgentParams = {
          model: draft.model ?? deps.defaultModel,
          name,
          instructions: draft.instructions ?? null,
          metadata: { ...(draft.metadata ?? {}), library_source: label, library_ref: ref },
          ...(draft.host_tools ? { host_tools: draft.host_tools } : {}),
          ...(draft.multi_agent ? { multi_agent: draft.multi_agent } : {}),
          ...(typeof draft.browser === 'boolean' ? { browser: draft.browser } : {}),
          ...(draft.apps ? { apps: clampGrants(draft.apps, deps.callerGrants ?? null) } : {}),
        }
        const created = await createSavedAgent(store, owner, params)
        return { id: created.id, name: created.name, link: `/agents/${created.id}` }
      }),

    tool('environment_list', 'List the user\'s environments (where chats run: isolated sandboxes and folders on this server) with their state. Use an id here for project_create. `chat_only` ones belong to a single chat and are deleted with it; do not use them for projects.',
      object({}),
      async () => {
        const records = await allEnvironments()
        return {
          environments: await Promise.all(records.map(async (record) => {
            const env = await deps.describe(record)
            return {
              id: env.id,
              name: env.name ?? record.provider_metadata['name'] ?? null,
              provider: env.provider,
              state: env.sandbox?.state ?? env.status,
              ...(env.template_id ? { template_id: env.template_id } : {}),
              ...(env.session_id ? { chat_only: true } : {}),
              ...(env.error ? { error: env.error } : {}),
              link: `/sandboxes/${env.id}`,
            }
          })),
        }
      }),
  ]
  for (const definition of tools) agentCtx.tools.register(definition)

  // Creating and changing need the user's approval; the approval bridge turns this into a required action.
  if (typeof (agentCtx as { on?: unknown }).on !== 'function') return
  const approve = async (exec: { name: string; arguments: unknown }, next: () => Promise<unknown>): Promise<unknown> => {
    if (!ASK_TOOLS.has(exec.name) && !(deps.askSchedules === true && SCHEDULE_ASK_TOOLS.has(exec.name))) return next()
    const text = await approvalText(exec.name, (exec.arguments ?? {}) as Args)
    return { kind: 'ask' as const, reason: text, displayReason: { en: text } }
  }
  agentCtx.on('tools/pre-execute', approve as never)

  /** One line naming what the call creates or changes, with names rather than ids where they can be read. */
  async function approvalText(name: string, args: Args): Promise<string> {
    const envName = async (id: unknown) => {
      const record = typeof id === 'string' ? await store.environments.get(owner, id).catch(() => undefined) : undefined
      return record?.provider_metadata['name'] ?? (typeof id === 'string' ? id : undefined)
    }
    const agentName = async (id: unknown) => {
      if (typeof id !== 'string') return undefined
      if (deps.builtinAgentIds?.has(id)) return id
      return (await store.agents.get(owner, id).catch(() => undefined))?.name ?? id
    }
    const projectName = async (id: unknown) => (typeof id === 'string' ? (await store.projects.get(owner, id).catch(() => undefined))?.name ?? id : undefined)
    if (name === 'project_create' || name === 'project_update') {
      const parts = [
        typeof args.agent_id === 'string' ? `agent "${String(await agentName(args.agent_id))}"` : args.agent_id === null ? 'default agent' : undefined,
        typeof args.environment_id === 'string' ? `environment "${String(await envName(args.environment_id))}"` : args.environment_id === null ? 'no environment' : undefined,
        str(args.directory) ? `folder ${String(str(args.directory))}` : undefined,
        args.pinned === true ? 'pinned' : undefined,
      ].filter(Boolean)
      const label = name === 'project_create' ? `Create project "${str(args.name) ?? ''}"` : `Update project "${String(await projectName(args.id))}"${str(args.name) ? ` (rename to "${String(str(args.name))}")` : ''}`
      return parts.length > 0 ? `${label}: ${parts.join(', ')}` : label
    }
    if (name === 'chat_move_to_project') {
      const which = str(args.session_id) && str(args.session_id) !== deps.sessionId ? `chat ${String(str(args.session_id))}` : 'this chat'
      return args.project_id === null ? `Move ${which} out of its project` : `Move ${which} to project "${String(await projectName(args.project_id))}"`
    }
    if (name === 'schedule_create') {
      const when = str(args.rrule)?.split('\n').find(line => line.startsWith('RRULE:'))?.slice(6) ?? str(args.at) ?? str(args.scheduledAt) ?? ''
      const prompt = (str(args.prompt) ?? '').replace(/\s+/gu, ' ').slice(0, 160)
      return `Create schedule "${str(args.title) ?? 'Scheduled task'}"${when ? ` (${when})` : ''}${prompt ? `: ${prompt}` : ''}`
    }
    if (name === 'schedule_edit') return `Change schedule ${str(args.id) ?? ''}`
    const ref = str(args.ref) ?? ''
    return `Add agent ${str(args.name) ? `"${String(str(args.name))}" ` : ''}from the Library (${ref})`
  }
}
