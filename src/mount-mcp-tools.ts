/**
 * Mount wire `type: "mcp"` tools as agent-scoped Host MCP clients.
 *
 * `@deepseek-ai/dsh-mcp-client` is imported only when a session declares MCP tools.
 */

import { createHash } from 'node:crypto'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { OAIMcpHttpTransport, OAIMcpStdioTransport, OAIMcpTool, OAIToolConfig } from './types.ts'

const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Caller-correctable wire MCP declaration failure. */
export class AgentsApiMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentsApiMcpConfigError'
  }
}

/**
 * Reject wire MCP entries this gateway cannot mount.
 * @param tool - one `type: "mcp"` agent tool.
 * @param index - index in `agent.tools` for error messages.
 * @returns an error message, or `undefined` when mountable.
 */
export function validateMcpTool(tool: OAIMcpTool, index: number): string | undefined {
  if (tool.credential_id != null && tool.credential_id !== '') {
    return `agent.tools[${index}] (mcp): credential_id is not supported; supply transport credentials in headers or env`
  }
  if (tool.connection_origin === 'service') {
    return `agent.tools[${index}] (mcp): connection_origin "service" is not supported; use client-supplied transport`
  }
  if (typeof tool.server_label !== 'string' || tool.server_label.trim().length === 0) {
    return `agent.tools[${index}] (mcp): server_label is required`
  }
  const transport: unknown = tool.transport
  if (transport === null || typeof transport !== 'object' || !('type' in transport) || typeof transport.type !== 'string') {
    return `agent.tools[${index}] (mcp): transport is required`
  }
  if (transport.type === 'http') {
    const http = transport as OAIMcpHttpTransport
    if (typeof http.server_url !== 'string' || http.server_url.trim().length === 0) {
      return `agent.tools[${index}] (mcp): transport.server_url is required for http`
    }
    try {
      const url = new URL(http.server_url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return `agent.tools[${index}] (mcp): transport.server_url must be an absolute HTTP(S) URL`
      }
    } catch {
      return `agent.tools[${index}] (mcp): transport.server_url must be an absolute HTTP(S) URL`
    }
    if (http.headers !== undefined) {
      const headerError = validateHeaders(http.headers, `agent.tools[${index}] (mcp): transport.headers`)
      if (headerError !== undefined) return headerError
    }
    return undefined
  }
  if (transport.type === 'stdio') {
    const stdio = transport as OAIMcpStdioTransport
    if (typeof stdio.command !== 'string' || stdio.command.trim().length === 0) {
      return `agent.tools[${index}] (mcp): transport.command is required for stdio`
    }
    if (stdio.args !== undefined && !Array.isArray(stdio.args)) {
      return `agent.tools[${index}] (mcp): transport.args must be a string array`
    }
    if (stdio.args?.some(arg => typeof arg !== 'string')) {
      return `agent.tools[${index}] (mcp): transport.args must be a string array`
    }
    if (stdio.env !== undefined) {
      const envError = validateEnv(stdio.env, `agent.tools[${index}] (mcp): transport.env`)
      if (envError !== undefined) return envError
    }
    return undefined
  }
  return `agent.tools[${index}] (mcp): unsupported transport type "${transport.type}"`
}

/** Narrow mcp-client surface used by this gateway. */
interface McpClientModule {
  Config: (input: Record<string, unknown>) => { serverName: string } & Record<string, unknown>
  name?: string
  apply?: unknown
  [key: string]: unknown
}

/**
 * Translate wire MCP tools into mcp-client configs and mount them on the agent scope.
 * @param agentCtx - agent-scoped Cordis context from `agents.create` setup.
 * @param tools - validated wire MCP tools.
 * @param sessionCwd - session workspace used as stdio cwd.
 */
export async function mountMcpTools(
  agentCtx: Context,
  tools: readonly OAIMcpTool[],
  sessionCwd: string,
): Promise<void> {
  if (tools.length === 0) return
  const McpClient = await import('@deepseek-ai/dsh-mcp-client') as unknown as McpClientModule
  const configs = resolveMcpConfigs(McpClient, tools, sessionCwd)
  for (const [i, config] of configs.entries()) {
    const wire = tools[i]
    if (wire === undefined) {
      throw new AgentsApiMcpConfigError(`MCP config/tool length mismatch at index ${i}`)
    }
    await agentCtx.plugin(McpClient as never, config as never)
    applyAllowedToolsGuard(agentCtx, config.serverName, wire)
  }
}

/**
 * Convert wire MCP tools into mcp-client configs.
 * @param McpClient - dynamic mcp-client module.
 * @param tools - validated wire MCP tools (same order as mount).
 * @param sessionCwd - session workspace for stdio servers.
 * @returns one mcp-client config per wire entry.
 */
export function resolveMcpConfigs(
  McpClient: McpClientModule,
  tools: readonly OAIMcpTool[],
  sessionCwd: string,
): Array<{ serverName: string } & Record<string, unknown>> {
  const names = new Set<string>()
  return tools.map((tool, index) => {
    const serverName = normalizeServerName(tool.server_label)
    if (names.has(serverName)) {
      throw new AgentsApiMcpConfigError(
        `agent.tools contains duplicate MCP server_label namespace: ${serverName}`,
      )
    }
    names.add(serverName)
    const failOnStartupError = tool.required !== false
    const transport = tool.transport
    if (transport.type === 'http') {
      const headers = transport.headers ?? {}
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'streamable-http',
        serverName,
        url: transport.server_url,
        headers,
        failOnStartupError,
      }))
      return { ...config, headers }
    }
    const env = transport.env ?? {}
    const config = validateClientConfig(index, () => McpClient.Config({
      transport: 'stdio',
      serverName,
      command: transport.command,
      args: transport.args ?? [],
      env,
      cwd: sessionCwd,
      failOnStartupError,
    }))
    return { ...config, env }
  })
}

/**
 * Collect wire MCP tools from an agent tool list.
 * @param tools - full `agent.tools` list.
 * @returns only `type: "mcp"` entries, in order.
 */
export function mcpToolsFrom(tools: readonly OAIToolConfig[]): OAIMcpTool[] {
  return tools.filter((tool): tool is OAIMcpTool => tool.type === 'mcp')
}

/** Parse a Host public MCP tool name into server label and raw name. */
export function parseMcpPublicName(
  publicName: string,
): { serverName: string; rawName: string } | undefined {
  const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(publicName)
  if (match === null) return undefined
  const serverName = match[1]
  const rawName = match[2]
  if (serverName === undefined || rawName === undefined) return undefined
  return { serverName, rawName }
}

function applyAllowedToolsGuard(
  agentCtx: Context,
  serverName: string,
  wire: OAIMcpTool,
): void {
  if (wire.allowed_tools === undefined || wire.allowed_tools === null) return
  const allowedRaw = new Set(wire.allowed_tools)
  const prefix = `mcp__${serverName}__`
  const label = wire.server_label
  agentCtx.tools.guard((exec) => {
    if (!exec.name.startsWith(prefix)) return undefined
    const parsed = parseMcpPublicName(exec.name)
    if (parsed !== undefined && allowedRaw.has(parsed.rawName)) return undefined
    return `MCP tool "${exec.name}" is not in allowed_tools for server "${label}"`
  })
}

function normalizeServerName(name: string): string {
  if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AgentsApiMcpConfigError('mcp server_label is invalid')
  }
  if (VALID_SERVER_NAME.test(name)) return name
  const slug = name.normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

function validateClientConfig(
  index: number,
  parse: () => { serverName: string } & Record<string, unknown>,
): { serverName: string } & Record<string, unknown> {
  try {
    return parse()
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AgentsApiMcpConfigError(`agent.tools[${index}] (mcp) is invalid: ${detail}`)
  }
}

function validateHeaders(
  headers: Record<string, string>,
  field: string,
): string | undefined {
  const names = new Set<string>()
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') return `${field} values must be strings`
    try {
      validateHeaderName(name)
      validateHeaderValue(name, value)
    } catch {
      return `${field} contains an invalid header entry`
    }
    const identity = name.toLowerCase()
    if (names.has(identity)) return `${field} contains duplicate name: ${name}`
    names.add(identity)
  }
  return undefined
}

function validateEnv(
  env: Record<string, string>,
  field: string,
): string | undefined {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') return `${field} values must be strings`
    if (
      name.length === 0
      || name.includes('=')
      || name.includes('\0')
      || value.includes('\0')
    ) {
      return `${field} contains an invalid environment entry`
    }
  }
  return undefined
}
