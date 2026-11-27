import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AGENTRY_BROWSER_SECTION,
  BROWSER_GUIDANCE,
  BROWSER_LOCAL_NOTICE,
  BROWSER_MISSING_NOTICE,
  browserCdpPort,
  BrowserPortAllocator,
  browserPorts,
  BROWSER_ABSENT_NOTICE,
  browserMode,
  normalizeBrowserDefault,
  browserMcpTool,
  mountBrowserGuidance,
  validateBrowserField,
} from '../src/mount-browser.ts'
import { bridgeConfigFromEnv } from '../src/sandbox/remote/stdio-bridge.ts'
import { validateMcpTool } from '../src/mount-mcp-tools.ts'
import type { OAIMcpStdioTransport } from '../src/types.ts'

const sandbox = { owner: 'alice', sandboxId: 'sbx_1', workspace: '/workspace', sessionId: 'sess_1' }
const credentials = { url: 'http://sandbox:3090', key: 'sk-secret' }

describe('browserMcpTool', () => {
  it('starts the bridge on the host and playwright-mcp inside the sandbox', () => {
    const tool = browserMcpTool(sandbox, credentials, '/opt/api/lib/sandbox-stdio-bridge.js')
    expect(tool).toMatchObject({ type: 'mcp', server_label: 'browser', required: false })
    expect(validateMcpTool(tool, 0)).toBeUndefined()
    const transport = tool.transport as OAIMcpStdioTransport
    expect(transport.command).toBe(process.execPath)
    expect(transport.args).toEqual(['/opt/api/lib/sandbox-stdio-bridge.js'])
    // The bridge reads what the MCP client hands it; the program runs in the sandbox's workspace.
    const config = bridgeConfigFromEnv(transport.env ?? {})
    const port = browserCdpPort('sess_1')
    expect(config).toEqual({
      url: 'http://sandbox:3090', key: 'sk-secret', owner: 'alice', sandboxId: 'sbx_1', cwd: '/workspace', user: 'agent',
      cmd: '/bin/sh',
      args: ['-c', expect.stringContaining('exec playwright-mcp --config "$AGENTRY_MCP_CONFIG_PATH" "$@"'), 'sh', '--browser', 'chromium', '--isolated', '--headless', '--output-dir', '/workspace/.browser'],
      env: {
        PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright',
        AGENTRY_MCP_CONFIG_PATH: `/tmp/agentry-browser-${String(port)}.json`,
        AGENTRY_MCP_CONFIG: JSON.stringify({ browser: { launchOptions: { args: [`--remote-debugging-port=${String(port)}`] } } }),
      },
    })
  })

  it('opens a DevTools port on the sandbox loopback, one per session, for the live view', () => {
    expect(browserCdpPort('sess_1')).toBe(browserCdpPort('sess_1'))
    expect(browserCdpPort('sess_1')).not.toBe(browserCdpPort('sess_2'))
    for (const id of ['a', 'b', 'sess_x', 'sess_0123456789']) {
      expect(browserCdpPort(id)).toBeGreaterThanOrEqual(20_000)
      expect(browserCdpPort(id)).toBeLessThan(40_000)
    }
  })

  it('keeps the service key out of the command line', () => {
    const transport = browserMcpTool(sandbox, credentials).transport as OAIMcpStdioTransport
    expect(JSON.stringify([transport.command, transport.args])).not.toContain('sk-secret')
  })
})

describe('browser field', () => {
  it('uses the agent value, else the server default', () => {
    expect(browserMode({ browser: true }, 'off')).toBe('on')
    expect(browserMode({ browser: false }, 'on')).toBe('off')
    expect(browserMode({ browser: null }, 'auto')).toBe('auto')
    expect(browserMode({}, 'auto')).toBe('auto')
    expect(browserMode({}, 'off')).toBe('off')
    expect(normalizeBrowserDefault(undefined)).toBe('auto')
    expect(normalizeBrowserDefault(true)).toBe('on')
    expect(normalizeBrowserDefault(false)).toBe('off')
    expect(normalizeBrowserDefault('on')).toBe('on')
  })

  it('accepts a boolean or null', () => {
    expect(validateBrowserField(undefined)).toBeUndefined()
    expect(validateBrowserField(null)).toBeUndefined()
    expect(validateBrowserField(false)).toBeUndefined()
    expect(validateBrowserField('true')).toBe('browser must be a boolean or null')
  })
})

describe('mountBrowserGuidance', () => {
  function scope(tools: string[]): { agentCtx: Context; text: () => string } {
    const sections: { name: string; text: (c: { scope?: unknown }) => string }[] = []
    const agentCtx = {
      get: (name: string) => name === 'systemPrompt' ? {} : undefined,
      systemPrompt: { section: (s: (typeof sections)[number]) => { sections.push(s) }, getSectionOrder: () => 2500 },
      tools: { get: (name: string) => tools.includes(name) ? { name } : undefined },
    } as unknown as Context
    return { agentCtx, text: () => { expect(sections[0]?.name).toBe(AGENTRY_BROWSER_SECTION); return sections[0]!.text({}) } }
  }

  it('gives the guidance while the browser tools are present', () => {
    const { agentCtx, text } = scope(['mcp__browser__browser_navigate'])
    mountBrowserGuidance(agentCtx, 'sandbox')
    expect(text()).toBe(BROWSER_GUIDANCE)
    expect(text()).toContain('passwords')
  })

  it('says why a local chat has no browser', () => {
    const { agentCtx, text } = scope([])
    mountBrowserGuidance(agentCtx, 'local')
    expect(text()).toBe(BROWSER_LOCAL_NOTICE)
  })

  it('says an auto-mode sandbox has no browser, and not to look in connected apps', () => {
    const { agentCtx, text } = scope([])
    mountBrowserGuidance(agentCtx, 'absent')
    expect(text()).toBe(BROWSER_ABSENT_NOTICE)
    expect(text()).toContain('connected apps')
    expect(text()).toContain('Web and browser')
  })

  it('says a Web browser template is needed when the sandbox browser did not start', () => {
    const { agentCtx, text } = scope([])
    mountBrowserGuidance(agentCtx, 'sandbox')
    expect(text()).toBe(BROWSER_MISSING_NOTICE)
    expect(text()).toContain('Web and browser')
    expect(text()).toContain('agentry-sandbox-browser:1')
  })
})

describe('BrowserPortAllocator', () => {
  const collide = (): BrowserPortAllocator => new BrowserPortAllocator(() => 25_000)

  it('gives sessions on one sandbox different ports even when their hashes collide', () => {
    const ports = collide()
    expect(ports.acquire('sbx', 'a')).toBe(25_000)
    expect(ports.acquire('sbx', 'b')).toBe(25_001)
  })

  it('is stable on re-acquire and lets the live view find the allocated port', () => {
    const ports = collide()
    ports.acquire('sbx', 'a')
    const b = ports.acquire('sbx', 'b')
    expect(ports.acquire('sbx', 'b')).toBe(b)
    expect(ports.portOf('sbx', 'b')).toBe(b)
    expect(ports.portOf('sbx', 'unknown')).toBe(25_000)
  })

  it('reuses released ports and keeps sandboxes independent', () => {
    const ports = collide()
    ports.acquire('sbx', 'a')
    ports.acquire('sbx', 'b')
    expect(ports.acquire('other', 'c')).toBe(25_000)
    ports.release('sbx', 'a')
    expect(ports.acquire('sbx', 'd')).toBe(25_000)
    ports.releaseSession('b')
    expect(ports.acquire('sbx', 'e')).toBe(25_001)
    ports.releaseSandbox('sbx')
    expect(ports.acquire('sbx', 'f')).toBe(25_000)
  })

  it('wraps inside 20000..39999', () => {
    const ports = new BrowserPortAllocator(() => 39_999)
    expect(ports.acquire('sbx', 'a')).toBe(39_999)
    expect(ports.acquire('sbx', 'b')).toBe(20_000)
  })

  it('mounts the tool on the allocated port', () => {
    const tool = browserMcpTool({ ...sandbox, sandboxId: 'sbx_alloc', sessionId: 'sess_alloc' }, credentials, '/b.js')
    expect(JSON.stringify(tool)).toContain(String(browserPorts.portOf('sbx_alloc', 'sess_alloc')))
    browserPorts.releaseSandbox('sbx_alloc')
  })
})
