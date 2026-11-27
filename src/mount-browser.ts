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
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { BROWSER_SANDBOX_IMAGE } from './environment/browser-image.ts'
import { BRIDGE_ENV } from './sandbox/remote/stdio-bridge.ts'
import { BROWSER_RECORDING_GUIDANCE, BROWSER_RECORDING_START } from './mount-browser-recording.ts'
import type { OAIAgent, OAIMcpTool } from './types.ts'

/** MCP server label; tools are `mcp__browser__browser_navigate` and so on. */
export const BROWSER_SERVER_LABEL = 'browser'

/** The pinned Playwright MCP version the browser sandbox image ships. */
export const PLAYWRIGHT_MCP_VERSION = '0.0.80'

/** Where the browser sandbox image keeps Chromium (envd processes do not get the image's ENV). */
export const SANDBOX_BROWSERS_PATH = '/opt/ms-playwright'

/** Section name for the browser guidance on the agent scope. */
export const AGENTRY_BROWSER_SECTION = 'agentry:browser'

/** Tool whose visibility means the browser started. */
const BROWSER_PROBE_TOOL = `mcp__${BROWSER_SERVER_LABEL}__browser_navigate`

/** The bridge program beside this module in a build (`lib/`). */
export const DEFAULT_BRIDGE_PATH = fileURLToPath(new URL('./sandbox-stdio-bridge.js', import.meta.url))

/** `on`: always try; `off`: never; `auto`: only when the chat's sandbox has the browser. */
export type BrowserMode = 'auto' | 'on' | 'off'

/** The server default (`browser.default`) as a mode; `true`/`false` stay accepted as on/off. */
export function normalizeBrowserDefault(value: boolean | BrowserMode | undefined): BrowserMode {
  if (value === true) return 'on'
  if (value === false) return 'off'
  return value ?? 'auto'
}

/** The agent's mode: `true` on, `false` off, absent or `null` the server default. */
export function browserMode(agent: Pick<OAIAgent, 'browser'>, serverDefault: BrowserMode): BrowserMode {
  if (agent.browser === true) return 'on'
  if (agent.browser === false) return 'off'
  return serverDefault
}

/** Command that succeeds when the sandbox has Playwright MCP (the program `browserMcpTool` starts). */
export const BROWSER_PROBE_COMMAND = 'command -v playwright-mcp'

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
  /** The chat's session id (picks the browser's DevTools port). */
  sessionId: string
  /** The environment's provider name (to reach the sandbox for the auto-mode check). */
  provider?: string
  /** The environment record's id (the live view and recordings are keyed by it). */
  environmentId?: string
}

/**
 * The DevTools port of a session's browser on the sandbox's loopback (20000-39999), derived from the session
 * id so the live view (`browser-live.ts`) finds it and two chats on one sandbox do not collide.
 */
export function browserCdpPort(sessionId: string): number {
  return 20_000 + (createHash('sha256').update(sessionId).digest().readUInt32BE(0) % 20_000)
}

const PORT_BASE = 20_000
const PORT_SPAN = 20_000

/**
 * Hands out DevTools ports per sandbox so two live sessions on one sandbox never share one. A session's
 * port starts at its hash-derived port and probes forward (wrapping inside 20000-39999) past ports other
 * sessions on that sandbox hold. In memory only: lost on restart, when the browsers are gone too.
 */
export class BrowserPortAllocator {
  private readonly held = new Map<string, Map<string, number>>()

  constructor(private readonly derive: (sessionId: string) => number = browserCdpPort) {}

  /** The session's port on this sandbox: its held one, else the first free one from its derived port. */
  acquire(sandboxId: string, sessionId: string): number {
    let sessions = this.held.get(sandboxId)
    if (sessions === undefined) this.held.set(sandboxId, sessions = new Map())
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const taken = new Set(sessions.values())
    const start = this.derive(sessionId) - PORT_BASE
    for (let i = 0; i < PORT_SPAN; i++) {
      const port = PORT_BASE + (start + i) % PORT_SPAN
      if (!taken.has(port)) {
        sessions.set(sessionId, port)
        return port
      }
    }
    throw new Error(`no free browser DevTools port on sandbox ${sandboxId}`)
  }

  /** The held port, or the derived port when this session holds none (for example after a restart). */
  portOf(sandboxId: string, sessionId: string): number {
    return this.held.get(sandboxId)?.get(sessionId) ?? this.derive(sessionId)
  }

  /** Frees one session's port on one sandbox. */
  release(sandboxId: string, sessionId: string): void {
    const sessions = this.held.get(sandboxId)
    if (sessions === undefined) return
    sessions.delete(sessionId)
    if (sessions.size === 0) this.held.delete(sandboxId)
  }

  /** Frees a session's ports on every sandbox. */
  releaseSession(sessionId: string): void {
    for (const sandboxId of [...this.held.keys()]) this.release(sandboxId, sessionId)
  }

  /** Frees every port of a sandbox (stopped, reset or deleted: its browsers are gone). */
  releaseSandbox(sandboxId: string): void {
    this.held.delete(sandboxId)
  }
}

/** The process-wide allocator used by the mounted tool and the live view. */
export const browserPorts = new BrowserPortAllocator()

/**
 * Stops what an earlier start for the same port left behind, then writes the Playwright MCP config (launch
 * arguments) to a file and starts playwright-mcp with it. An API restart leaves the old playwright-mcp and its
 * Chromium running in the sandbox; that Chromium keeps the DevTools port, the new one runs without it, and the
 * live view would show the old browser. The patterns hold the values, and this script's own command line only
 * the variable names, so it never matches itself.
 */
export const START_WITH_CONFIG = [
  'if command -v pkill >/dev/null 2>&1; then',
  '  old="playwright-mcp --config $AGENTRY_MCP_CONFIG_PATH"; cdp="remote-debugging-port=$AGENTRY_MCP_PORT"',
  '  pkill -TERM -f "$old" 2>/dev/null; pkill -TERM -f "$cdp" 2>/dev/null',
  '  i=0; while { pgrep -f "$old" || pgrep -f "$cdp"; } >/dev/null 2>&1 && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done',
  '  pkill -KILL -f "$old" 2>/dev/null; pkill -KILL -f "$cdp" 2>/dev/null',
  'fi',
  'printf "%s" "$AGENTRY_MCP_CONFIG" > "$AGENTRY_MCP_CONFIG_PATH" && exec playwright-mcp --config "$AGENTRY_MCP_CONFIG_PATH" "$@"',
].join('\n')

/**
 * The in-memory MCP tool that starts the browser inside `sandbox`.
 * @param sandbox - the sandbox the session runs in.
 * @param credentials - Agentry Sandbox service URL and key (bridge environment only).
 * @param bridgePath - the bridge program (default: beside this module).
 */
export function browserMcpTool(sandbox: BrowserSandbox, credentials: { url: string; key: string }, bridgePath = DEFAULT_BRIDGE_PATH): OAIMcpTool {
  // Chromium also listens for DevTools on the sandbox's loopback, so the live view can screencast it.
  const port = browserPorts.acquire(sandbox.sandboxId, sandbox.sessionId)
  const command = ['/bin/sh', '-c', START_WITH_CONFIG, 'sh', '--browser', 'chromium', '--isolated', '--headless', '--output-dir', `${sandbox.workspace.replace(/\/+$/, '')}/.browser`]
  const mcpConfig = { browser: { launchOptions: { args: [`--remote-debugging-port=${String(port)}`] } } }
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
        [BRIDGE_ENV.programEnv]: JSON.stringify({
          PLAYWRIGHT_BROWSERS_PATH: SANDBOX_BROWSERS_PATH,
          AGENTRY_MCP_CONFIG_PATH: `/tmp/agentry-browser-${String(port)}.json`,
          AGENTRY_MCP_PORT: String(port),
          AGENTRY_MCP_CONFIG: JSON.stringify(mcpConfig),
        }),
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
export const BROWSER_MISSING_NOTICE = `The web browser is turned on for this agent, but it could not start in this sandbox: the standard sandbox image does not include it. If the user needs a browser, tell them to start a new chat on the built-in "Web and browser" template (or a custom template using the image \`${BROWSER_SANDBOX_IMAGE}\`).`

/** Shown in an auto-mode chat whose sandbox has no browser. */
export const BROWSER_ABSENT_NOTICE = `This sandbox has no web browser, so you have no browser tools: do not look for one in connected apps. If the user needs a browser, tell them to start a new chat on an environment made from the built-in "Web and browser" template (image \`${BROWSER_SANDBOX_IMAGE}\`).`

/**
 * Register the browser section on the agent scope. In a sandbox chat it shows
 * the guidance while the browser tools are visible, or a notice that the
 * browser did not start; in a local chat it explains why there is no browser;
 * `absent` (auto mode, sandbox without the browser) says there is none.
 */
export function mountBrowserGuidance(agentCtx: Context, mode: 'sandbox' | 'local' | 'absent'): void {
  if (agentCtx.get('systemPrompt') === undefined) return
  agentCtx.systemPrompt.section({
    name: AGENTRY_BROWSER_SECTION,
    order: agentCtx.systemPrompt.getSectionOrder('TOOL_SCHEDULE') + 2,
    text: ({ scope }) => browserGuidanceText(mode, agentCtx.tools.get(BROWSER_PROBE_TOOL, scope) !== undefined, agentCtx.tools.get(BROWSER_RECORDING_START, scope) !== undefined),
  })
}

/** The section text for a chat `mode` and whether the browser tools (and the recording tools) are present. */
export function browserGuidanceText(mode: 'sandbox' | 'local' | 'absent', hasTools: boolean, hasRecording = false): string {
  if (hasTools) return hasRecording ? `${BROWSER_GUIDANCE}\n${BROWSER_RECORDING_GUIDANCE}` : BROWSER_GUIDANCE
  if (mode === 'absent') return BROWSER_ABSENT_NOTICE
  return mode === 'local' ? BROWSER_LOCAL_NOTICE : BROWSER_MISSING_NOTICE
}
