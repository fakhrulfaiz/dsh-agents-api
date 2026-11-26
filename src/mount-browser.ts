/**
 * The web browser (Playwright MCP) for agents that have it turned on.
 *
 * It runs only inside an Agentry Sandbox: the session gets one stdio MCP
 * server whose process on the API host is the stdio bridge
 * (`lib/sandbox-stdio-bridge.js`), which starts `playwright-mcp` in the
 * sandbox over envd and relays bytes. The browser therefore uses the
 * sandbox's limits, network rules and file system. A chat that does not run
 * in a sandbox gets no browser tools, and the prompt says why.
 *
 * The tool is built at mount time (create and resume) and never stored in the
 * session's saved config; the service key travels in the bridge's environment.
 */
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { BRIDGE_ENV } from './sandbox/remote/stdio-bridge.ts'
import type { OAIAgent, OAIMcpTool } from './types.ts'

/** MCP server label; tools are `mcp__browser__browser_navigate` and so on. */
export const BROWSER_SERVER_LABEL = 'browser'

/** The pinned Playwright MCP version the standard sandbox image ships. */
export const PLAYWRIGHT_MCP_VERSION = '0.0.80'

/** Where the standard sandbox image keeps Chromium (envd processes do not get the image's ENV). */
export const SANDBOX_BROWSERS_PATH = '/opt/ms-playwright'

/** Section name for the browser guidance on the agent scope. */
export const AGENTRY_BROWSER_SECTION = 'agentry:browser'

/** Tool whose visibility means the browser started. */
const BROWSER_PROBE_TOOL = `mcp__${BROWSER_SERVER_LABEL}__browser_navigate`

/** The bridge program beside this module in a build (`lib/`). */
export const DEFAULT_BRIDGE_PATH = fileURLToPath(new URL('./sandbox-stdio-bridge.js', import.meta.url))

/** Whether the agent has the browser: its `browser` field, else the server default. */
export function browserEnabled(agent: Pick<OAIAgent, 'browser'>, serverDefault: boolean): boolean {
  return typeof agent.browser === 'boolean' ? agent.browser : serverDefault
}

/** `browser` must be a boolean or null when present. */
export function validateBrowserField(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === 'boolean') return undefined
  return 'browser must be a boolean or null'
}

export interface BrowserSandbox {
  owner: string
  sandboxId: string
  /** The sandbox's workspace path (inside the sandbox). */
  workspace: string
}

/**
 * The in-memory MCP tool that starts the browser inside `sandbox`.
 * @param sandbox - the sandbox the session runs in.
 * @param credentials - Agentry Sandbox service URL and key (bridge environment only).
 * @param bridgePath - the bridge program (default: beside this module).
 */
export function browserMcpTool(sandbox: BrowserSandbox, credentials: { url: string; key: string }, bridgePath = DEFAULT_BRIDGE_PATH): OAIMcpTool {
  const command = ['playwright-mcp', '--browser', 'chromium', '--isolated', '--headless', '--output-dir', `${sandbox.workspace.replace(/\/+$/, '')}/.browser`]
  return {
    type: 'mcp',
    server_label: BROWSER_SERVER_LABEL,
    required: false,
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [bridgePath],
      env: {
        [BRIDGE_ENV.url]: credentials.url,
        [BRIDGE_ENV.key]: credentials.key,
        [BRIDGE_ENV.owner]: sandbox.owner,
        [BRIDGE_ENV.sandboxId]: sandbox.sandboxId,
        [BRIDGE_ENV.cwd]: sandbox.workspace,
        [BRIDGE_ENV.user]: 'agent',
        [BRIDGE_ENV.command]: JSON.stringify(command),
        [BRIDGE_ENV.programEnv]: JSON.stringify({ PLAYWRIGHT_BROWSERS_PATH: SANDBOX_BROWSERS_PATH }),
      },
    },
  }
}

/** The bridge's working directory on the API host (the sandbox workspace path need not exist there). */
export const BRIDGE_HOST_CWD = tmpdir()

/** Guidance while the browser tools are present. */
export const BROWSER_GUIDANCE = [
  'Web browser (the `mcp__browser__*` tools): a headless Chromium inside this chat\'s sandbox, under the sandbox\'s network rules.',
  '- Use it for pages that need JavaScript, a login or interaction (clicking, typing, forms). For plain reading of a public page prefer a simple fetch.',
  '- Work from page snapshots (`browser_snapshot`, and the snapshot each action returns). Take a screenshot only when the layout or an image matters, or the user asks to see the page.',
  '- Never type passwords, one-time codes or payment details unless the user gave them for that site in this chat.',
  '- Stopping a turn does not undo clicks or submissions already made. Ask before submitting anything that sends, buys, posts or deletes.',
  '- Browser state (open pages, cookies, logins) does not survive the end of this chat\'s session.',
].join('\n')

/** Shown when the agent has the browser on but the chat runs on the server, not in a sandbox. */
export const BROWSER_LOCAL_NOTICE = 'The web browser is turned on for this agent, but it runs only in sandbox chats, and this chat runs on the server, so you have no browser tools here. If the user needs a browser, tell them to start the chat on a sandbox environment.'

/** Shown when the browser should run in this sandbox but did not start. */
export const BROWSER_MISSING_NOTICE = 'The web browser is turned on for this agent, but it could not start in this sandbox (an older sandbox image may not have it). If the user needs a browser, tell them that resetting the sandbox to the current image adds it.'

/**
 * Register the browser section on the agent scope. In a sandbox chat it shows
 * the guidance while the browser tools are visible, or a notice that the
 * browser did not start; in a local chat it explains why there is no browser.
 */
export function mountBrowserGuidance(agentCtx: Context, mode: 'sandbox' | 'local'): void {
  if (agentCtx.get('systemPrompt') === undefined) return
  agentCtx.systemPrompt.section({
    name: AGENTRY_BROWSER_SECTION,
    order: agentCtx.systemPrompt.getSectionOrder('TOOL_SCHEDULE') + 2,
    text: ({ scope }) => browserGuidanceText(mode, agentCtx.tools.get(BROWSER_PROBE_TOOL, scope) !== undefined),
  })
}

/** The section text for a chat `mode` and whether the browser tools are present. */
export function browserGuidanceText(mode: 'sandbox' | 'local', hasTools: boolean): string {
  if (hasTools) return BROWSER_GUIDANCE
  return mode === 'local' ? BROWSER_LOCAL_NOTICE : BROWSER_MISSING_NOTICE
}
