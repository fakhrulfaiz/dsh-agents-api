/**
 * Output redaction for MCP tool secrets. Stored agent and session records keep
 * real `headers` and `env` values because mounting and restart recovery need
 * them; every wire response and SSE event passes through these helpers.
 */

import type { OAIAgent, OAIAgentSession, OAIToolConfig } from './types.ts'

/** Replacement for every MCP header and env value on output. */
export const MASKED_SECRET = '***'

function maskValues(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map(name => [name, MASKED_SECRET]))
}

function redactTool(tool: OAIToolConfig): OAIToolConfig {
  if (tool.type !== 'mcp') return tool
  const { transport } = tool
  if (transport.type === 'http') {
    if (transport.headers === undefined) return tool
    return { ...tool, transport: { ...transport, headers: maskValues(transport.headers) } }
  }
  if (transport.env === undefined) return tool
  return { ...tool, transport: { ...transport, env: maskValues(transport.env) } }
}

/**
 * Mask secret values in an agent's MCP tools: `http` header values and `stdio`
 * env values become `***`; names, `command`, and `args` stay. Idempotent.
 * @param agent - stored or projected agent; not mutated.
 * @returns a copy safe to send to clients.
 */
export function redactAgentSecrets(agent: OAIAgent): OAIAgent {
  if (!agent.tools.some(tool => tool.type === 'mcp')) return agent
  return { ...agent, tools: agent.tools.map(redactTool) }
}

/**
 * Mask MCP secrets in a session resource's agent.
 * @param session - wire session; not mutated.
 * @returns a copy safe to send to clients.
 */
export function redactSessionSecrets(session: OAIAgentSession): OAIAgentSession {
  return { ...session, agent: redactAgentSecrets(session.agent) }
}

/**
 * Find an MCP header or env value that is the output mask, which means a
 * client echoed back a redacted resource.
 * @param tools - tools from an update body.
 * @returns a description of the first masked entry, or `undefined`.
 */
export function findMaskedSecret(tools: readonly OAIToolConfig[]): string | undefined {
  for (const tool of tools) {
    if (tool.type !== 'mcp') continue
    const values = tool.transport.type === 'http' ? tool.transport.headers : tool.transport.env
    const kind = tool.transport.type === 'http' ? 'header' : 'env'
    for (const [name, value] of Object.entries(values ?? {})) {
      if (value === MASKED_SECRET) return `MCP server "${tool.server_label}" ${kind} "${name}"`
    }
  }
  return undefined
}
