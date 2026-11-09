/**
 * Test double for the Cordis calls `installApprovalBridge` makes, so tests
 * invoke the registered listeners directly.
 */

import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { installApprovalBridge, type ApprovalBridge } from '../../src/approvals/approval-bridge.ts'
import type { OAIRequiredAction } from '../../src/types.ts'
import { logEvent } from './fake-session-query.ts'

type Listener = (...args: never[]) => unknown

/** Harness around one installed bridge. */
export interface BridgeHarness {
  bridge: ApprovalBridge
  /** Sessions the bridge claims; any other agent is delegated. */
  claimed: Set<string>
  onChange: ReturnType<typeof vi.fn<(sessionId: string, actions: OAIRequiredAction[]) => void>>
  /** Number of registered effects whose disposer has run. */
  disposed: () => number
  agent: (sessionId: string) => Agent
  /** Invoke the `approval/request` listener; `next` answers `'unavailable'` like the real fallback. */
  approve: (request: Omit<ApprovalRequestEvent, 'agent'> & { agent: Agent }) => Promise<ApprovalOutcome>
  /** Invoke the `user-questions/request` listener; `next` rejects like an unanswered question. */
  ask: (request: AskUserQuestionRequestEvent) => Promise<AskUserQuestionAnswer>
  /** Deliver a Session event to the bridge's `session/event` listener. */
  log: (sessionId: string, type: string, data: unknown, seq?: number) => void
  /** Let queued microtasks run. */
  flush: () => Promise<void>
}

/**
 * Install a bridge over a fake context.
 * @param claimed - session ids the bridge claims.
 * @returns the harness.
 */
export function bridgeHarness(claimed: string[] = ['sess_1']): BridgeHarness {
  const listeners = new Map<string, Listener>()
  let disposed = 0
  const ctx = {
    effect: (register: () => () => void) => {
      const dispose = register()
      return () => {
        disposed += 1
        dispose()
      }
    },
    on: (name: string, listener: Listener) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  } as unknown as Context
  const claims = new Set(claimed)
  const onChange = vi.fn<(sessionId: string, actions: OAIRequiredAction[]) => void>()
  const bridge = installApprovalBridge(ctx, {
    claims: agent => claims.has(agent.session.id) ? agent.session.id : undefined,
    onChange,
  })
  const call = <R>(name: string, ...args: unknown[]): R => (listeners.get(name) as unknown as (...a: unknown[]) => R)(...args)
  return {
    bridge,
    claimed: claims,
    onChange,
    disposed: () => disposed,
    agent: sessionId => ({ session: { id: sessionId } }) as unknown as Agent,
    approve: request => call('approval/request', request, () => Promise.resolve('unavailable')),
    ask: request => call('user-questions/request', request, () => Promise.reject(new Error('delegated'))),
    log: (sessionId, type, data, seq = 1) => {
      call<void>('session/event', { id: sessionId, header: {} }, logEvent(type, data, seq) as SessionEvent)
    },
    flush: () => new Promise(resolve => setImmediate(resolve)),
  }
}

/**
 * One question with options.
 * @param id - question id.
 * @param labels - option labels.
 * @returns the question item.
 */
export function question(id: string, labels: string[] = ['A', 'B']): AskUserQuestionItem {
  return { id, question: `Pick ${id}`, options: labels.map(label => ({ label })) }
}
