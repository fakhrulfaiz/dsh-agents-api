/**
 * Mount wire `type: "function"` tools as scoped Host tools that park on execute.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PendingFunctionCalls } from './pending-function-calls.ts'
import type { OAIFunctionTool, OAIToolConfig } from './types.ts'

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
}

/**
 * Reject agent tool lists that this gateway cannot mount.
 * @param tools - wire `agent.tools` entries.
 * @returns an error message, or `undefined` when every entry is mountable.
 */
export function validateMountableTools(tools: readonly OAIToolConfig[]): string | undefined {
  for (const tool of tools) {
    if (tool.type !== 'function') {
      return `Unsupported agent.tools entry type "${tool.type}"; only type "function" is mounted`
    }
    if (typeof tool.name !== 'string' || tool.name === '') {
      return 'Each type "function" tool requires a non-empty name'
    }
    if (tool.defer_loading === true) {
      return `Function tool "${tool.name}" sets defer_loading; tool_search is not supported`
    }
  }
  return undefined
}

/**
 * Register each wire function tool on the agent scope.
 *
 * Profile/global Host tools remain visible; a same-name scoped registration
 * shadows the global for this session.
 *
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 * @param tools - validated wire function tools.
 * @param pending - per-session parked-call registry.
 * @param getTurnId - current Agents API turn id when execute starts.
 */
export function mountFunctionTools(
  agentCtx: Context,
  tools: readonly OAIFunctionTool[],
  pending: PendingFunctionCalls,
  getTurnId: () => string,
): void {
  for (const tool of tools) {
    agentCtx.tools.register(createParkedFunctionTool(tool, pending, getTurnId))
  }
}

function createParkedFunctionTool(
  tool: OAIFunctionTool,
  pending: PendingFunctionCalls,
  getTurnId: () => string,
): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? EMPTY_OBJECT_SCHEMA,
    output: {
      schema: { type: 'string' },
      render(_args: unknown, value: unknown) {
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        return [{ type: 'text' as const, text }]
      },
    },
    async execute(args: unknown, exec) {
      const callArgs = isPlainObject(args) ? args : {}
      return pending.wait({
        callId: String(exec.callId),
        name: tool.name,
        arguments: callArgs,
        turnId: getTurnId(),
        signal: exec.signal,
      })
    },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
