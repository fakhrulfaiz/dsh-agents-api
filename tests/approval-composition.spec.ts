/**
 * Real `dsh-user-approval` + `dsh-session`: the bridge pairs the wire id with
 * the `approval/asked` event DSH really logs, and delegates other sessions.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { claimAgent, installApprovalBridge } from '../src/approvals/approval-bridge.ts'

async function composed(): Promise<{ ctx: Context; open: (meta?: { parentSession: Agent['session']['id']; origin: 'subagent' }) => Agent }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService)
  const open = (meta?: { parentSession: Agent['session']['id']; origin: 'subagent' }): Agent => {
    const session = ctx.sessions.create(undefined, meta === undefined ? undefined : { meta })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'seed' }] }), { surfaceOp: 'append' })
    return { session } as Agent
  }
  return { ctx, open }
}

describe('approval bridge on the real approval service', () => {
  it('parks a request under the logged id until the client answers', async () => {
    const { ctx, open } = await composed()
    const agent = open()
    const onChange = vi.fn()
    const bridge = installApprovalBridge(ctx, { claims: candidate => candidate.session.id === agent.session.id ? { sessionId: agent.session.id } : undefined, onChange })
    const logged: string[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'approval/asked') logged.push(event.data.id)
    })

    const outcome = ctx.approval.request({ agent, toolName: 'bash', reason: 'run it' })
    await new Promise(resolve => setImmediate(resolve))
    const [action] = bridge.pending(agent.session.id)
    expect(action).toMatchObject({ kind: 'tool_approval', tool_name: 'bash', id: logged[0] })
    expect(bridge.answer(agent.session.id, logged[0]!, 'approve')).toBe('resolved')
    await expect(outcome).resolves.toBe('allowed-once')
    expect(bridge.pending(agent.session.id)).toEqual([])
  })

  it('claims a session request ahead of an answerer registered earlier that never settles', async () => {
    const { ctx, open } = await composed()
    const agent = open()
    // Stands in for the DSH web remote bridge, which is mounted before this plugin and holds the request for a connected tab.
    ctx.on('approval/request', () => new Promise<never>(() => {}))
    const bridge = installApprovalBridge(ctx, { claims: candidate => candidate.session.id === agent.session.id ? { sessionId: agent.session.id } : undefined, onChange: vi.fn() })

    const outcome = ctx.approval.request({ agent, toolName: 'bash', reason: 'run it' })
    await new Promise(resolve => setImmediate(resolve))
    const [action] = bridge.pending(agent.session.id)
    expect(action).toMatchObject({ kind: 'tool_approval', tool_name: 'bash' })
    expect(bridge.answer(agent.session.id, action!.id, 'deny')).toBe('resolved')
    await expect(outcome).resolves.toBe('rejected')
  })

  it('falls through to the next answerer for a session it does not own', async () => {
    const { ctx, open } = await composed()
    const bridge = installApprovalBridge(ctx, { claims: () => undefined, onChange: vi.fn() })
    ctx.on('approval/request', () => Promise.resolve('rejected'))
    const agent = open()
    await expect(ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('rejected')
    expect(bridge.pending(agent.session.id)).toEqual([])
  })

  it('stops claiming requests once its plugin is disposed', async () => {
    const { ctx, open } = await composed()
    const agent = open()
    let bridge: ReturnType<typeof installApprovalBridge> | undefined
    const fiber = await ctx.plugin({
      name: 'bridge-host',
      apply(inner: Context) {
        bridge = installApprovalBridge(inner, { claims: candidate => ({ sessionId: candidate.session.id }), onChange: vi.fn() })
      },
    })
    await fiber.dispose()
    await expect(ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('unavailable')
    expect(bridge!.pending(agent.session.id)).toEqual([])
  })

  it('shows a subagent request on the registered parent, marked with the child, and the parent answers it', async () => {
    const { ctx, open } = await composed()
    const parent = open()
    const child = open({ parentSession: parent.session.id, origin: 'subagent' })
    const onChange = vi.fn()
    const bridge = installApprovalBridge(ctx, { claims: candidate => claimAgent(candidate, id => id === parent.session.id), onChange })
    const logged: string[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'approval/asked') logged.push(event.data.id)
    })

    const outcome = ctx.approval.request({ agent: child, toolName: 'bash', reason: 'run it' })
    await new Promise(resolve => setImmediate(resolve))
    expect(bridge.pending(child.session.id)).toEqual([])
    const [action] = bridge.pending(parent.session.id)
    expect(action).toMatchObject({ kind: 'tool_approval', id: logged[0], subagent_id: child.session.id })
    // The parent's turn ending leaves the child's request pending.
    parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    expect(bridge.pending(parent.session.id)).toHaveLength(1)
    expect(bridge.answer(parent.session.id, logged[0]!, 'approve')).toBe('resolved')
    await expect(outcome).resolves.toBe('allowed-once')
  })
})
