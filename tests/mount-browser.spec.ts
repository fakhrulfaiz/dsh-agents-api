import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AGENTRY_BROWSER_SECTION,
  BROWSER_GUIDANCE,
  BROWSER_LOCAL_NOTICE,
  BROWSER_MISSING_NOTICE,
  browserEnabled,
  browserMcpTool,
  mountBrowserGuidance,
  validateBrowserField,
} from '../src/mount-browser.ts'
import { bridgeConfigFromEnv } from '../src/sandbox/remote/stdio-bridge.ts'
import { validateMcpTool } from '../src/mount-mcp-tools.ts'
import type { OAIMcpStdioTransport } from '../src/types.ts'

const sandbox = { owner: 'alice', sandboxId: 'sbx_1', workspace: '/workspace' }
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
    expect(config).toEqual({
      url: 'http://sandbox:3090', key: 'sk-secret', owner: 'alice', sandboxId: 'sbx_1', cwd: '/workspace', user: 'agent',
      cmd: 'playwright-mcp', args: ['--browser', 'chromium', '--isolated', '--headless', '--output-dir', '/workspace/.browser'],
      env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright' },
    })
  })

  it('keeps the service key out of the command line', () => {
    const transport = browserMcpTool(sandbox, credentials).transport as OAIMcpStdioTransport
    expect(JSON.stringify([transport.command, transport.args])).not.toContain('sk-secret')
  })
})

describe('browser field', () => {
  it('uses the agent value, else the server default', () => {
    expect(browserEnabled({ browser: true }, false)).toBe(true)
    expect(browserEnabled({ browser: false }, true)).toBe(false)
    expect(browserEnabled({ browser: null }, true)).toBe(true)
    expect(browserEnabled({}, false)).toBe(false)
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

  it('says a Web browser template is needed when the sandbox browser did not start', () => {
    const { agentCtx, text } = scope([])
    mountBrowserGuidance(agentCtx, 'sandbox')
    expect(text()).toBe(BROWSER_MISSING_NOTICE)
    expect(text()).toContain('Web browser')
    expect(text()).toContain('agentry-sandbox-browser:1')
  })
})
