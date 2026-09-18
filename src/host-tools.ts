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
 * Apply a validated Host tool mask on the agent scope.
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 * @param hostTools - validated mask; no-op when absent.
 */
export function applyHostToolsRestrict(
  agentCtx: Context,
  hostTools: OAIHostToolsConfig | null | undefined,
): void {
  if (hostTools === undefined || hostTools === null) return
  const allow = hostTools.allow
  const deny = hostTools.deny
  if (allow == null && deny == null) return
  agentCtx.tools.restrict({
    ...(allow != null ? { allow } : {}),
    ...(deny != null ? { deny } : {}),
  })
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
