/**
 * Validate and apply DSH `host_tools` masks onto a scoped Host tool registry.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OAIHostToolsConfig } from './types.ts'

/**
 * Reject empty or non-array `host_tools` filters before session create.
 * @param hostTools - wire `host_tools` field, or omitted.
 * @returns an error message, or `undefined` when valid / absent.
 */
export function validateHostTools(hostTools: OAIHostToolsConfig | null | undefined): string | undefined {
  if (hostTools === undefined || hostTools === null) return undefined
  const allow = hostTools.allow
  const deny = hostTools.deny
  if (allow == null && deny == null) {
    return 'host_tools requires allow and/or deny'
  }
  if (allow != null && !isStringArray(allow)) {
    return 'host_tools.allow must be an array of tool name strings'
  }
  if (deny != null && !isStringArray(deny)) {
    return 'host_tools.deny must be an array of tool name strings'
  }
  return undefined
}

/**
 * Host tools no Agentry session may use. `plugin_manager` installs plugins
 * host-wide into the server process for every user; operators install plugins
 * from the DSH GUI or `dsh plugin add` instead.
 */
export const ALWAYS_DENIED_HOST_TOOLS: readonly string[] = ['plugin_manager']

/**
 * Apply a validated Host tool mask on the agent scope. DSH's `tools.restrict` masks only the
 * preset's (global) tools and refuses any other name, so the names of tools this session
 * registered on its own scope (`scopeNames`, see `withToolFilter`) are left out of the mask.
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 * @param hostTools - validated mask; no-op when absent.
 * @param scopeNames - tools registered (or skipped) on the agent scope.
 */
export function applyHostToolsRestrict(
  agentCtx: Context,
  hostTools: OAIHostToolsConfig | null | undefined,
  scopeNames: ReadonlySet<string> = new Set(),
): void {
  const allow = hostTools?.allow?.filter(name => !scopeNames.has(name))
  const deny = [...new Set([...(hostTools?.deny ?? []), ...ALWAYS_DENIED_HOST_TOOLS])].filter(name => !scopeNames.has(name))
  agentCtx.tools.restrict({
    ...(allow != null ? { allow } : {}),
    deny,
  })
}

/**
 * The agent scope with a filtered `tools.register`: a tool `keep` refuses is not registered.
 * This is how a `host_tools` mask reaches tools the session registers on its own scope
 * (agent, Agentry, sandbox and skill tools), which `tools.restrict` cannot mask. Every
 * name passed to `register` is added to `seen`, for `applyHostToolsRestrict`.
 * @param agentCtx - agent-scoped Cordis context.
 * @param keep - whether a scope tool stays.
 * @param seen - collects the scope tool names.
 */
export function withToolFilter(agentCtx: Context, keep: (name: string) => boolean, seen: Set<string>): Context {
  const tools = agentCtx.tools
  const filtered = new Proxy(tools, {
    get(target, prop) {
      if (prop === 'register') {
        return (definition: { name: string }, ...rest: unknown[]) => {
          seen.add(definition.name)
          return keep(definition.name) ? (target.register as (...args: unknown[]) => unknown)(definition, ...rest) : () => {}
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  return new Proxy(agentCtx, {
    get(target, prop) {
      if (prop === 'tools') return filtered
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
