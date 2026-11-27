/**
 * The agent's side of browser take-over: a `tools/pre-execute` gate and a `tools/post-execute` note for
 * the browser tools (`mcp__browser__*`, Playwright MCP through the stdio bridge).
 *
 * - While the user has control, a browser call waits (the turn stays parked, as in a remote desktop) until
 *   they hand it back, control times out, or the turn is stopped (then the call is cancelled).
 * - The call that waited never runs: it was planned on a page the user has since changed. It answers
 *   `HANDED_BACK_NOTE` instead. If the user only watched (no input), it runs as usual.
 * - After a hand-back with input, any browser call other than a look at the page (snapshot, screenshot,
 *   console, network) answers the same note, and the first look gets the note in front of its result.
 *
 * Gating here, in the API, and not in the bridge, is reliable: every browser call of the session passes
 * this hook whatever its transport, the decision is made before anything reaches the sandbox, and the
 * note reaches the model as the tool's own answer.
 */
import type { BrowserLiveHub } from './browser-live.ts'

export const BROWSER_TOOL_PREFIX = 'mcp__browser__'

/** What the agent is told after the user used the browser and handed it back. */
export const HANDED_BACK_NOTE = 'The user used the browser and handed it back; look at the page again before continuing.'

/** Browser tools that only look at the page; they may run right after a hand-back. */
const LOOK_TOOLS = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests'])

export type BrowserGateDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'cancel' }

/** Whether `name` is one of the browser's tools. */
export function isBrowserTool(name: string): boolean {
  return name.startsWith(BROWSER_TOOL_PREFIX)
}

/**
 * The pre-execute decision for a tool call `name` in `sessionId`.
 * @param signal - the call's cancellation (a stopped turn ends the wait).
 */
export async function browserToolGate(hub: BrowserLiveHub, sessionId: string, name: string, signal?: AbortSignal): Promise<BrowserGateDecision> {
  if (!isBrowserTool(name)) return { kind: 'allow' }
  if (hub.controlled(sessionId)) {
    await hub.waitForRelease(sessionId, signal)
    if (signal?.aborted === true) return { kind: 'cancel' }
    if (hub.handedBackSince(sessionId)) return { kind: 'deny', reason: HANDED_BACK_NOTE }
    return { kind: 'allow' }
  }
  if (hub.handedBackSince(sessionId) && !LOOK_TOOLS.has(name.slice(BROWSER_TOOL_PREFIX.length))) {
    return { kind: 'deny', reason: HANDED_BACK_NOTE }
  }
  return { kind: 'allow' }
}

/**
 * After a look at the page following a hand-back: the note to put in front of the result (and the agent
 * has now looked). `undefined` when there is nothing to add.
 */
export function browserLookNote(hub: BrowserLiveHub, sessionId: string, name: string, isError: boolean): string | undefined {
  if (!isBrowserTool(name) || isError || !hub.handedBackSince(sessionId)) return undefined
  if (!LOOK_TOOLS.has(name.slice(BROWSER_TOOL_PREFIX.length))) return undefined
  hub.clearHandedBack(sessionId)
  return HANDED_BACK_NOTE
}
