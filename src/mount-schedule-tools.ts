/**
 * Owner-scoped `schedule_create`, `schedule_list`, `schedule_view` and
 * `schedule_edit` for each session's agent.
 *
 * DSH's `@deepseek-ai/dsh-tool-schedule` registers these tools in the preset
 * scope over the Host schedule service, which has no owner: every chat could
 * list, read and change every user's tasks. Each session's agent scope gets
 * its own copies, which shadow the preset's (a scope's own registration wins
 * a name). The copies are DSH's own definitions, built by running the
 * package's `apply` against a service view limited to the session owner, so
 * their schemas, descriptions, errors and results stay DSH's.
 *
 * Ownership is derived as on `/v1/agents/schedules` (`ownerOf` in
 * `schedules.ts`): the owner of the target session, else of the first involved
 * session with an index row. A task of another owner, and a task whose owner
 * cannot be determined, is left out of lists and answers `schedule_not_found`
 * to view and edit.
 */

import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, ScheduleInputError } from '@deepseek-ai/dsh-schedule'
import type {
  ScheduleCatalogEntry,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleListRequest,
  ScheduleListResult,
  ScheduleService,
  ScheduleViewRequest,
  ScheduleViewResult,
} from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { apply as applyScheduleTools } from '@deepseek-ai/dsh-tool-schedule'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OwnerId } from './auth/authenticator.ts'
import { candidateSessionIds, ownerOf } from './schedules.ts'
import type { Store } from './store/store.ts'
import type { OAIHostToolsConfig } from './types.ts'

/** The tools DSH's schedule plugin registers; each one is shadowed per session. */
export const SCHEDULE_TOOL_NAMES = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'] as const

/** What the owner-scoped service needs. */
export interface OwnedScheduleDeps {
  /** The Host schedule service, read at call time. */
  schedule: () => ScheduleService | undefined
  /** Owners by session id (`store.sessions.ownersOf`). */
  ownersOf: Store['sessions']['ownersOf']
  /** The session owner every call acts for. */
  owner: OwnerId
}

/** The service members DSH's schedule tools call. */
export type OwnedScheduleService = Pick<ScheduleService, 'deliveryLimits' | 'create' | 'list' | 'view' | 'edit'>

/** Default spacing reported when the Host service is missing at mount time (the tools then fail at call time). */
const NO_LIMITS = { newSessionIntervalSeconds: 60 }

/**
 * A view of the Host schedule service limited to the tasks `owner` owns.
 * Creating is unchanged: a created task's target or acting session is the
 * caller's own session, so it belongs to the caller.
 * @param deps - Host service, owner lookup, and owner.
 * @returns the owner-scoped service.
 */
export function ownedScheduleService(deps: OwnedScheduleDeps): OwnedScheduleService {
  const service = (): ScheduleService => {
    const found = deps.schedule()
    if (found === undefined) throw new Error('the schedule service is not available')
    return found
  }
  const owns = async (entry: ScheduleCatalogEntry): Promise<boolean> => {
    const owned = ownerOf(entry, await deps.ownersOf(candidateSessionIds(entry)))
    return owned !== undefined && owned.owner === deps.owner
  }
  return {
    deliveryLimits: () => deps.schedule()?.deliveryLimits() ?? NO_LIMITS,
    create: (request, actorSessionId?: SessionId, signal?: AbortSignal) => service().create(request, actorSessionId, signal),
    async list(request: ScheduleListRequest = {}): Promise<ScheduleListResult> {
      const limit = request.limit ?? DEFAULT_LIST_LIMIT
      const offset = request.offset ?? 0
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
        throw new ScheduleInputError('invalid_rule', `limit must be 1-${MAX_LIST_LIMIT} and offset must be a non-negative integer.`)
      }
      // The catalog has the Host list's order (active first) and the involved sessions ownership needs.
      const catalog = await service().catalog()
      const owners = await deps.ownersOf([...new Set(catalog.flatMap(candidateSessionIds))])
      const items = catalog.filter(entry => ownerOf(entry, owners)?.owner === deps.owner
        && (request.active === undefined || (entry.status === 'active') === request.active))
      const page = items.slice(offset, offset + limit)
      return { items: page, shown: page.length, total: items.length, limit, offset }
    },
    async view(request: ScheduleViewRequest): Promise<ScheduleViewResult> {
      const found = await service().view(request)
      if ('code' in found || !(await owns(found))) return { id: request.id, code: 'schedule_not_found' }
      return found
    },
    async edit(request: ScheduleEditRequest, actorSessionId?: SessionId, signal?: AbortSignal): Promise<ScheduleEditResult> {
      // Checked before any change: another owner's task looks like an unknown id.
      const found = await service().view({ id: request.id })
      if ('code' in found || !(await owns(found))) return { id: request.id, code: 'schedule_not_found' }
      return service().edit(request, actorSessionId, signal)
    },
  }
}

/**
 * DSH's schedule tool definitions over `service`: runs the plugin's `apply`
 * against a context that holds only that service and captures what it
 * registers (its prompt section stays with the preset's own copy).
 * @param service - the service the tools act through.
 * @returns the definitions, by name.
 */
export function scheduleToolDefinitions(service: OwnedScheduleService): Map<string, ToolDefinition> {
  const definitions = new Map<string, ToolDefinition>()
  const scoped = {
    schedule: service,
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: {
      register: (definition: ToolDefinition) => {
        definitions.set(definition.name, definition)
        return () => {}
      },
    },
  }
  const ctx = { ...scoped, inject: (_deps: readonly string[], callback: (inner: typeof scoped) => void) => { callback(scoped) } }
  applyScheduleTools(ctx as unknown as Context)
  return definitions
}

/** Whether a session's `host_tools` mask leaves `name` visible (`applyHostToolsRestrict`). */
function admitted(hostTools: OAIHostToolsConfig | null | undefined, name: string): boolean {
  if (hostTools?.allow != null && !hostTools.allow.includes(name)) return false
  return !(hostTools?.deny ?? []).includes(name)
}

/** What `mountScheduleTools` needs. */
export interface ScheduleToolsDeps extends OwnedScheduleDeps {
  /** The session's `host_tools` mask: a tool it hides gets no copy (a scope's own tools are not masked). */
  hostTools?: OAIHostToolsConfig | null | undefined
}

/**
 * Register the owner-scoped schedule tools on a session's agent scope, where
 * they shadow the preset's. Nothing is registered when the Host has no
 * schedule service (the preset then has no schedule tools either).
 * @param agentCtx - agent-scoped context from `agents.create` setup.
 * @param deps - Host service, owner lookup, owner, and `host_tools` mask.
 */
export function mountScheduleTools(agentCtx: Context, deps: ScheduleToolsDeps): void {
  if (deps.schedule() === undefined) return
  const definitions = scheduleToolDefinitions(ownedScheduleService(deps))
  for (const name of SCHEDULE_TOOL_NAMES) {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`@deepseek-ai/dsh-tool-schedule no longer registers ${name}; the owner-scoped copy cannot be built`)
    if (admitted(deps.hostTools, name)) agentCtx.tools.register(definition)
  }
}
