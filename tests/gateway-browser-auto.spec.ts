/** Auto-mode browser: mounted only when the sandbox has it; explicit off and local chats never notice. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AgentsGateway } from '../src/gateway.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { setSandboxCredentials } from '../src/sandbox/presets.ts'
import { SandboxRegistry } from '../src/sandbox/registry.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { BROWSER_ABSENT_NOTICE, BROWSER_GUIDANCE, BROWSER_LOCAL_NOTICE } from '../src/mount-browser.ts'
import { BROWSER_RECORDING_GUIDANCE, BROWSER_RECORDING_START, BROWSER_RECORDING_STOP } from '../src/mount-browser-recording.ts'
import type { OAIAgent } from '../src/types.ts'
import { openAuthenticator } from './open-auth.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hasToolsRef = { value: false }
function hasToolsOn() { hasToolsRef.value = true }
const mounted = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../src/mount-mcp-tools.ts', async (orig) => ({
  ...await orig<typeof import('../src/mount-mcp-tools.ts')>(),
  mountMcpTools: async (...args: unknown[]) => { mounted.calls.push(args) },
}))

beforeEach(() => { hasToolsRef.value = false; mounted.calls.length = 0; setSandboxCredentials({ url: 'http://sbx', key: 'k' }) })
afterEach(() => { setSandboxCredentials(undefined) })

function setup(has: boolean | Error, browserDefault?: 'auto' | 'on' | 'off') {
  const sandboxHasBrowser = vi.fn(async () => { if (has instanceof Error) throw has; return has })
  const registry = new SandboxRegistry('local')
  registry.register(createLocalProvider(join(tmpdir(), 'agentry-auto-spec-envs')))
  registry.register({ kind: 'sandbox', listEntries: async () => [], api: () => ({ envd: () => ({}) }) } as never)
  const ctx = { logger: { warn: vi.fn(), info: vi.fn() }, get: () => undefined } as unknown as Context
  const options = { ...testGatewayOptions(registry, new FakeSessionQuery()), sandboxHasBrowser, ...(browserDefault ? { browserDefault } : {}) }
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), options)
  const sections: { text: (c: { scope?: unknown }) => string }[] = []
  const hasTools = hasToolsRef
  const registered: string[] = []
  const agentCtx = {
    get: (name: string) => name === 'systemPrompt' ? {} : undefined,
    systemPrompt: { section: (s: (typeof sections)[number]) => { sections.push(s) }, getSectionOrder: () => 1 },
    tools: {
      get: (name: string) => (name.startsWith('browser_recording_') ? registered.includes(name) && hasTools.value : hasTools.value) ? {} : undefined,
      register: (def: { name: string }) => { registered.push(def.name) },
    },
  } as unknown as Context
  const mount = async (browser: boolean | null | undefined, sandbox = true) => {
    sections.length = 0
    const agent = { id: 'a', ...(browser === undefined ? {} : { browser }) } as unknown as OAIAgent
    await (api as unknown as { mountBrowser: (...a: unknown[]) => Promise<void> }).mountBrowser(agentCtx, agent, sandbox ? { owner: 'o', sandboxId: 'sbx_1', workspace: '/workspace', sessionId: 's', provider: 'sandbox', environmentId: 'env_1' } : undefined)
    return sections[0]?.text({})
  }
  return { api, mount, sandboxHasBrowser, registered }
}

describe('browser auto mode', () => {
  it('mounts the browser and the recording tools when the sandbox has it', async () => {
    const { mount, sandboxHasBrowser, registered } = setup(true)
    hasToolsOn()
    expect(await mount(null)).toBe(`${BROWSER_GUIDANCE}\n${BROWSER_RECORDING_GUIDANCE}`)
    expect(mounted.calls).toHaveLength(1)
    expect(registered).toEqual([BROWSER_RECORDING_START, BROWSER_RECORDING_STOP])
    expect(sandboxHasBrowser).toHaveBeenCalledTimes(1)
  })

  it('registers no recording tools where the browser is not mounted', async () => {
    const absent = setup(false)
    await absent.mount(null)
    expect(absent.registered).toEqual([])
    const off = setup(true)
    await off.mount(false)
    expect(off.registered).toEqual([])
    const local = setup(true)
    await local.mount(true, false)
    expect(local.registered).toEqual([])
  })

  it('registers no recording tools when the browser MCP failed to mount', async () => {
    const { mount, registered } = setup(true)
    const failing = vi.spyOn(await import('../src/mount-mcp-tools.ts'), 'mountMcpTools')
    failing.mockRejectedValueOnce(new Error('no client'))
    await mount(true)
    expect(registered).toEqual([])
    failing.mockRestore()
  })

  it('adds the notice and no tools when the sandbox has none', async () => {
    const { mount } = setup(false)
    expect(await mount(undefined)).toBe(BROWSER_ABSENT_NOTICE)
    expect(mounted.calls).toHaveLength(0)
  })

  it('checks a sandbox once, and again after it is forgotten (reset)', async () => {
    const { mount, sandboxHasBrowser, api } = setup(true)
    await mount(null)
    await mount(null)
    expect(sandboxHasBrowser).toHaveBeenCalledTimes(1)
    ;(api as unknown as { browserProbes: Map<string, unknown> }).browserProbes.delete('sbx_1')
    await mount(null)
    expect(sandboxHasBrowser).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed check', async () => {
    const { mount, sandboxHasBrowser } = setup(new Error('boom'))
    expect(await mount(null)).toBe(BROWSER_ABSENT_NOTICE)
    await mount(null)
    expect(sandboxHasBrowser).toHaveBeenCalledTimes(2)
  })

  it('never mounts or notices when the agent has it off', async () => {
    const { mount, sandboxHasBrowser } = setup(true)
    expect(await mount(false)).toBeUndefined()
    expect(mounted.calls).toHaveLength(0)
    expect(sandboxHasBrowser).not.toHaveBeenCalled()
  })

  it('does nothing in a local chat on auto, but explains on an explicit true', async () => {
    const { mount, sandboxHasBrowser } = setup(true)
    expect(await mount(null, false)).toBeUndefined()
    expect(await mount(true, false)).toBe(BROWSER_LOCAL_NOTICE)
    expect(sandboxHasBrowser).not.toHaveBeenCalled()
    expect(mounted.calls).toHaveLength(0)
  })

  it('true mounts without checking', async () => {
    const { mount, sandboxHasBrowser } = setup(false)
    await mount(true)
    expect(mounted.calls).toHaveLength(1)
    expect(sandboxHasBrowser).not.toHaveBeenCalled()
  })

  it('follows the server default: off mounts nothing, on mounts', async () => {
    const off = setup(true, 'off')
    expect(await off.mount(null)).toBeUndefined()
    expect(mounted.calls).toHaveLength(0)
    const on = setup(false, 'on')
    await on.mount(null)
    expect(mounted.calls).toHaveLength(1)
  })
})

describe('browser recording at turn end', () => {
  it('stops a running recording when the turn ends', () => {
    const { api } = setup(true)
    const turnEnded = vi.spyOn(api.browserRecorder, 'turnEnded').mockReturnValue(Promise.resolve())
    api.applySessionEvent('s', { type: 'turn/end', seq: 2 } as never)
    expect(turnEnded).toHaveBeenCalledWith('s')
    api.applySessionEvent('s', { type: 'turn/start', seq: 3 } as never)
    expect(turnEnded).toHaveBeenCalledTimes(1)
  })
})
