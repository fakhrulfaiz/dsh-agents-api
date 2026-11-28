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

  it('starts all MCP fibers before awaiting any of them', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const starts: string[] = []
    const guards: Array<(exec: { name: string }) => string | undefined> = []
    const agentCtx = {
      plugin: vi.fn(async (_client: unknown, config: { serverName: string }) => {
        starts.push(config.serverName)
        await gate
      }),
      tools: {
        guard: (fn: (exec: { name: string }) => string | undefined) => {
          guards.push(fn)
          return () => undefined
        },
      },
    } as unknown as Context
    const localTool: OAIMcpTool = {
      type: 'mcp',
      server_label: 'local',
      transport: { type: 'http', server_url: 'https://example.org/mcp' },
      allowed_tools: ['search'],
    }
    let run: Promise<void> | undefined
    try {
      run = mountMcpTools(agentCtx, mcpToolsFrom([httpTool, localTool]), '/tmp')
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(starts).toEqual(['docs', 'local'])
      release()
      await run
      expect(guards).toHaveLength(2)
      expect(guards[0]!({ name: 'mcp__docs__search' })).toBeUndefined()
      expect(guards[1]!({ name: 'mcp__local__search' })).toBeUndefined()
      expect(guards[0]!({ name: 'mcp__docs__delete' })).toMatch(/allowed_tools/)
    } finally {
      release()
      await run?.catch(() => undefined)
    }
  })

  it('rejects if one mount fails', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const starts: string[] = []
    const agentCtx = {
      plugin: vi.fn(async (_client: unknown, config: { serverName: string }) => {
        starts.push(config.serverName)
        if (config.serverName === 'docs') throw new Error('boom')
        await gate
      }),
      tools: { guard: () => () => undefined },
    } as unknown as Context
    const localTool: OAIMcpTool = {
      type: 'mcp',
      server_label: 'local',
      transport: { type: 'http', server_url: 'https://example.org/mcp' },
    }
    try {
      await expect(mountMcpTools(agentCtx, mcpToolsFrom([httpTool, localTool]), '/tmp')).rejects.toThrow('boom')
      expect(starts).toEqual(['docs', 'local'])
    } finally {
      release()
    }
  })

  it('rejects duplicate labels before mounting', async () => {
    const plugin = vi.fn(async () => undefined)
    const agentCtx = { plugin, tools: { guard: () => () => undefined } } as unknown as Context
    await expect(mountMcpTools(agentCtx, mcpToolsFrom([httpTool, { ...httpTool }]), '/tmp')).rejects.toThrow(/duplicate MCP/)
    expect(plugin).not.toHaveBeenCalled()
  })

  it('logs per-server and total durations when AGENTRY_DEBUG_TIMING=1', async () => {
    const previous = process.env['AGENTRY_DEBUG_TIMING']
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      process.env['AGENTRY_DEBUG_TIMING'] = '1'
      const agentCtx = {
        plugin: vi.fn(async () => undefined),
        tools: { guard: () => () => undefined },
      } as unknown as Context
      await mountMcpTools(agentCtx, mcpToolsFrom([httpTool]), '/tmp')
      const output = write.mock.calls.map(call => String(call[0])).join('')
      expect(output).toMatch(/\[agentry-timing\] mcp mounts: docs=\d+ms; total=\d+ms/)
      expect(output).not.toContain('example.com')
      expect(output).not.toContain('Bearer t')
    } finally {
      write.mockRestore()
      if (previous === undefined) delete process.env['AGENTRY_DEBUG_TIMING']
      else process.env['AGENTRY_DEBUG_TIMING'] = previous
    }
  })

  it('does not log without the flag', async () => {
    const previous = process.env['AGENTRY_DEBUG_TIMING']
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      delete process.env['AGENTRY_DEBUG_TIMING']
      const agentCtx = {
        plugin: vi.fn(async () => undefined),
        tools: { guard: () => () => undefined },
      } as unknown as Context
      await mountMcpTools(agentCtx, mcpToolsFrom([httpTool]), '/tmp')
      const output = write.mock.calls.map(call => String(call[0])).join('')
      expect(output).not.toContain('[agentry-timing]')
    } finally {
      write.mockRestore()
      if (previous === undefined) delete process.env['AGENTRY_DEBUG_TIMING']
      else process.env['AGENTRY_DEBUG_TIMING'] = previous
    }
  })
})
