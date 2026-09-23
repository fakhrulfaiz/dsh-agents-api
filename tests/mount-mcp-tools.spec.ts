import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  mcpToolsFrom,
  mountMcpTools,
  parseMcpPublicName,
  resolveMcpConfigs,
} from '../src/mount-mcp-tools.ts'
import type { OAIMcpTool } from '../src/types.ts'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({
  Config: (input: Record<string, unknown>) => ({ ...input }),
  name: 'mcp-client',
}))

const httpTool: OAIMcpTool = {
  type: 'mcp',
  server_label: 'docs',
  transport: { type: 'http', server_url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } },
  allowed_tools: ['search'],
}

describe('resolveMcpConfigs', () => {
  it('maps http and stdio transports and rejects a duplicate namespace', () => {
    const McpClient = {
      Config: (input: Record<string, unknown>) => input as { serverName: string } & Record<string, unknown>,
    }
    const configs = resolveMcpConfigs(McpClient, [
      httpTool,
      {
        type: 'mcp',
        server_label: 'local',
        transport: { type: 'stdio', command: 'echo', args: ['hi'], env: { A: '1' } },
        required: false,
      },
    ], '/tmp/workspace')
    expect(configs[0]).toMatchObject({
      transport: 'streamable-http',
      serverName: 'docs',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
      failOnStartupError: true,
    })
    expect(configs[1]).toMatchObject({
      transport: 'stdio',
      serverName: 'local',
      command: 'echo',
      args: ['hi'],
      env: { A: '1' },
      cwd: '/tmp/workspace',
      failOnStartupError: false,
    })
    expect(() => resolveMcpConfigs(McpClient, [httpTool, { ...httpTool }], '/tmp')).toThrow(/duplicate MCP/)
  })
})

describe('mountMcpTools', () => {
  it('does not load the client when the session has no MCP tools', async () => {
    const agentCtx = { plugin: vi.fn() } as unknown as Context
    await mountMcpTools(agentCtx, [], '/tmp')
    expect(agentCtx.plugin).not.toHaveBeenCalled()
  })

  it('mounts the client and guards allowed tool names', async () => {
    const guards: Array<(exec: { name: string }) => string | undefined> = []
    const agentCtx = {
      plugin: vi.fn(async () => undefined),
      tools: {
        guard: (fn: (exec: { name: string }) => string | undefined) => {
          guards.push(fn)
          return () => undefined
        },
      },
    } as unknown as Context
    await mountMcpTools(agentCtx, mcpToolsFrom([
      { type: 'function', name: 'ping' },
      httpTool,
    ]), '/tmp/workspace')
    expect(agentCtx.plugin).toHaveBeenCalledTimes(1)
    expect(guards).toHaveLength(1)
    expect(guards[0]!({ name: 'mcp__docs__search' })).toBeUndefined()
    expect(guards[0]!({ name: 'mcp__docs__delete' })).toMatch(/allowed_tools/)
    expect(guards[0]!({ name: 'bash' })).toBeUndefined()
    expect(parseMcpPublicName('mcp__docs__search')).toEqual({ serverName: 'docs', rawName: 'search' })
  })
})
