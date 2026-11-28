/**
 * The owner's Composio tool, built in memory each time a session's agent is created or resumed.
 *
 * The owner's consumer key lives sealed in the store (`OwnerSecrets`, name `composio`). The tool built
 * here is mounted with the session's own MCP tools and is never written to the session's saved config,
 * so a replaced key reaches every session on its next start or resume, scheduled runs included.
 */
import type { AgentAppGrants, OAIMcpTool } from './types.ts'

/** Composio's MCP endpoint (`composio.mcpUrl` default). */
export const DEFAULT_COMPOSIO_MCP_URL = 'https://connect.composio.dev/mcp'

/** Name of the owner secret that holds the Composio consumer key. */
export const COMPOSIO_SECRET = 'composio'

/**
 * Whether an agent's grants allow no app at all (`apps: {}` or every app with an empty tool list).
 * `null` grants mean any app. Such agents get no owner Composio tool, so they start without contacting Composio.
 * @param grants - `effectiveGrants(agent)`.
 */
export function grantsAllowNoApps(grants: AgentAppGrants | null): boolean {
  return grants !== null && Object.values(grants).every(grant => Array.isArray(grant) && grant.length === 0)
}

/**
 * @param tools - the session's own MCP tools.
 * @param key - the owner's Composio consumer key, or `undefined` when none is stored.
 * @param url - Composio's MCP endpoint.
 * @param serverLabel - label of the Composio tools (`composio.serverLabel`).
 * @returns the wire tool to mount, or `undefined` when there is no key or the session already has a tool with that label.
 */
export function ownerComposioTool(tools: readonly OAIMcpTool[], key: string | undefined, url: string, serverLabel = 'composio'): OAIMcpTool | undefined {
  if (key === undefined || key === '') return undefined
  if (tools.some(tool => tool.server_label === serverLabel)) return undefined
  return {
    type: 'mcp',
    server_label: serverLabel,
    // A Composio outage must not fail the session: it starts without the tools instead.
    required: false,
    transport: { type: 'http', server_url: url, headers: { 'x-consumer-api-key': key } },
  }
}
