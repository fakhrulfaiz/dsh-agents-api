import { describe, expect, it } from 'vitest'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { AgentsApiRequestError } from '../src/errors.ts'
import { bridgeHarness, question } from './support/bridge-harness.ts'

const CALL = 'call_1' as never

function request(h: ReturnType<typeof bridgeHarness>, extra: Record<string, unknown> = {}, session = 'sess_1') {
  return { agent: h.agent(session), toolName: 'bash', callId: CALL, reason: 'run rm', ...extra } as ApprovalRequestEvent
}

describe('approval requests', () => {
  it('becomes a pending action with the id DSH logged', async () => {
    const h = bridgeHarness()
    h.log('sess_1', 'approval/asked', { id: 'appr-1', toolName: 'bash', callId: CALL, reason: 'run rm' })
    const outcome = h.approve(request(h))
    expect(h.bridge.pending('sess_1')).toEqual([{
      type: 'approval',
      id: 'appr-1',
      kind: 'tool_approval',
      prompt: 'run rm',
      options: ['approve', 'deny'],
      tool_name: 'bash',
      call_id: CALL,
    }])
    expect(h.onChange).toHaveBeenCalledWith('sess_1', h.bridge.pending('sess_1'))
    expect(h.bridge.answer('sess_1', 'appr-1', 'approve')).toBe('resolved')
    await expect(outcome).resolves.toBe('allowed-once')
    expect(h.bridge.pending('sess_1')).toEqual([])
    expect(h.onChange).toHaveBeenLastCalledWith('sess_1', [])
  })

  it('pairs concurrent requests with their own logged ids by call id', () => {
    const h = bridgeHarness()
    h.log('sess_1', 'approval/asked', { id: 'a', toolName: 'bash', callId: 'c1' })
    h.log('sess_1', 'approval/asked', { id: 'b', toolName: 'bash', callId: 'c2' })
    void h.approve(request(h, { callId: 'c2' as never }))
    void h.approve(request(h, { callId: 'c1' as never }))
    expect(h.bridge.pending('sess_1').map(a => [a.type === 'approval' && a.id, a.type === 'approval' && a.call_id])).toEqual([['b', 'c2'], ['a', 'c1']])
  })

  it('mints an id when no asked event precedes the request', () => {
    const h = bridgeHarness()
    void h.approve(request(h))
    const [action] = h.bridge.pending('sess_1')
    expect(action).toMatchObject({ type: 'approval', id: expect.stringMatching(/^appr_/u) })
  })

  it('uses the display reason when there is one and the tool name otherwise', () => {
    const h = bridgeHarness()
    void h.approve(request(h, { displayReason: { en: 'Delete the build folder' } }))
    void h.approve(request(h, { reason: undefined, callId: undefined, toolName: 'edit' }))
    expect(h.bridge.pending('sess_1').map(a => a.type === 'approval' && a.prompt)).toEqual(['Delete the build folder', 'Approve edit'])
  })

  it('maps the real sandbox escalation reason to sandbox_escalation', async () => {
    const h = bridgeHarness()
    let captured: ApprovalRequestEvent | undefined
    const outcome = approveEscalation(
      { requestedMode: 'danger-full-access', effectiveMode: 'workspace-write', justification: 'needs network', subject: 'command' },
      {
        approver: { request: (req: ApprovalRequestEvent) => { captured = req; return Promise.resolve('rejected' as const) } },
        agent: h.agent('sess_1'),
        toolName: 'bash',
        callId: CALL,
      } as never,
    )
    await expect(outcome).rejects.toThrow()
    void h.approve(captured!)
    expect(h.bridge.pending('sess_1')[0]).toMatchObject({ type: 'approval', kind: 'sandbox_escalation' })
  })

  it('resolves rejected on deny', async () => {
    const h = bridgeHarness()
    h.log('sess_1', 'approval/asked', { id: 'x', toolName: 'bash' })
    const outcome = h.approve(request(h, { callId: undefined }))
    expect(h.bridge.answer('sess_1', 'x', 'deny')).toBe('resolved')
    await expect(outcome).resolves.toBe('rejected')
  })

  it('rejects an answer decision on an approval and keeps it pending', () => {
    const h = bridgeHarness()
    h.log('sess_1', 'approval/asked', { id: 'x', toolName: 'bash', callId: CALL })
    void h.approve(request(h))
    expect(() => h.bridge.answer('sess_1', 'x', 'answer', { selected: ['A'] })).toThrow(expect.objectContaining({ status: 400, code: 'decision_not_applicable' }))
    expect(h.bridge.pending('sess_1')).toHaveLength(1)
  })

  it('is not found after the first answer, cancelAll, or an abort', async () => {
    const h = bridgeHarness()
    h.log('sess_1', 'approval/asked', { id: 'x', toolName: 'bash', callId: CALL })
    const first = h.approve(request(h))
    h.bridge.answer('sess_1', 'x', 'approve')
    await first
    expect(h.bridge.answer('sess_1', 'x', 'approve')).toBe('not_found')

    h.log('sess_1', 'approval/asked', { id: 'y', toolName: 'bash', callId: CALL })
    const second = h.approve(request(h))
    h.bridge.cancelAll('sess_1')
    await expect(second).resolves.toBe('cancelled')
    expect(h.bridge.answer('sess_1', 'y', 'approve')).toBe('not_found')

    h.log('sess_1', 'approval/asked', { id: 'z', toolName: 'bash', callId: CALL })
    const controller = new AbortController()
    const third = h.approve(request(h, { signal: controller.signal }))
    controller.abort()
    await h.flush()
    expect(h.bridge.pending('sess_1')).toEqual([])
    expect(h.bridge.answer('sess_1', 'z', 'approve')).toBe('not_found')
    expect(h.onChange).toHaveBeenLastCalledWith('sess_1', [])
    void third
  })

  it('drops pending requests when the turn ends', async () => {
    const h = bridgeHarness()
    h.log('sess_1', 'approval/asked', { id: 'x', toolName: 'bash', callId: CALL })
    const outcome = h.approve(request(h))
    h.log('sess_1', 'turn/end', { reason: { kind: 'aborted' } }, 2)
    await expect(outcome).resolves.toBe('cancelled')
    expect(h.bridge.answer('sess_1', 'x', 'approve')).toBe('not_found')
  })

  it('delegates agents it does not own', async () => {
    const h = bridgeHarness()
    await expect(h.approve(request(h, {}, 'child_1'))).resolves.toBe('unavailable')
    await expect(h.ask({ agent: h.agent('child_1'), questions: [question('q')] })).rejects.toThrow('delegated')
    expect(h.onChange).not.toHaveBeenCalled()
    expect(h.bridge.pending('child_1')).toEqual([])
  })

  it('delegates a request whose signal already aborted', async () => {
    const h = bridgeHarness()
    const controller = new AbortController()
    controller.abort()
    await expect(h.approve(request(h, { signal: controller.signal }))).resolves.toBe('unavailable')
  })
})

describe('user questions', () => {
  it('lists the option labels of a single question and resolves a batch', async () => {
    const h = bridgeHarness()
    const answer = h.ask({ agent: h.agent('sess_1'), questions: [question('q1', ['A', 'B'])] })
    const [action] = h.bridge.pending('sess_1')
    expect(action).toMatchObject({ type: 'approval', kind: 'user_question', prompt: 'Pick q1', options: ['A', 'B'] })
    const id = (action as { id: string }).id
    expect(h.bridge.answer('sess_1', id, 'answer', { selected: ['A'] })).toBe('resolved')
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('carries custom text and the full item list for several questions', async () => {
    const h = bridgeHarness()
    const answer = h.ask({ agent: h.agent('sess_1'), questions: [question('q1'), question('q2')] })
    const action = h.bridge.pending('sess_1')[0]!
    expect(action).toMatchObject({ options: [], prompt: 'Pick q1\nPick q2', questions: [{ id: 'q1' }, { id: 'q2' }] })
    expect(() => h.bridge.answer('sess_1', (action as { id: string }).id, 'answer', { selected: ['A'] })).toThrow(expect.objectContaining({ status: 400, code: 'invalid_approval_response' }))
    expect(() => h.bridge.answer('sess_1', (action as { id: string }).id, 'answer', { answers: [{ id: 'q1', selected: ['A'] }] })).toThrow(expect.objectContaining({ code: 'invalid_approval_response' }))
    expect(() => h.bridge.answer('sess_1', (action as { id: string }).id, 'answer', { answers: [{ id: 'q1', selected: ['A'] }, { id: 'q9', selected: [] }] })).toThrow(AgentsApiRequestError)
    h.bridge.answer('sess_1', (action as { id: string }).id, 'answer', { answers: [{ id: 'q1', selected: [] , custom: 'mine' }, { id: 'q2', selected: ['B'] }] })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'mine' }, { id: 'q2', selected: ['B'] }] })
  })

  it('treats deny as a skipped batch and refuses approve', async () => {
    const h = bridgeHarness()
    const answer = h.ask({ agent: h.agent('sess_1'), questions: [question('q1'), question('q2')] })
    const id = (h.bridge.pending('sess_1')[0] as { id: string }).id
    expect(() => h.bridge.answer('sess_1', id, 'approve')).toThrow(expect.objectContaining({ status: 400, code: 'decision_not_applicable' }))
    h.bridge.answer('sess_1', id, 'deny')
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }] })
  })

  it('uses the wait call id as the wire id', () => {
    const h = bridgeHarness()
    void h.ask({ agent: h.agent('sess_1'), questions: [question('q1')], wait: { callId: 'wait_1' as never } })
    expect(h.bridge.pending('sess_1')[0]).toMatchObject({ id: 'wait_1' })
  })

  it('rejects the question on cancel and on abort', async () => {
    const h = bridgeHarness()
    const first = h.ask({ agent: h.agent('sess_1'), questions: [question('q1')] })
    h.bridge.cancelAll('sess_1')
    await expect(first).rejects.toThrow('question cancelled')
    const controller = new AbortController()
    const second = h.ask({ agent: h.agent('sess_1'), questions: [question('q1')], signal: controller.signal })
    controller.abort()
    await expect(second).rejects.toThrow('question cancelled')
    expect(h.bridge.pending('sess_1')).toEqual([])
  })

  it('does not claim a timed question', async () => {
    const h = bridgeHarness()
    await expect(h.ask({ agent: h.agent('sess_1'), questions: [question('q1')], wait: { callId: 'w' as never, timed: true } })).rejects.toThrow('delegated')
    expect(h.bridge.pending('sess_1')).toEqual([])
  })
})

describe('subagent requests', () => {
  it('shows a child approval on its parent with subagent_id and the logged id', async () => {
    const h = bridgeHarness()
    h.log('child_1', 'approval/asked', { id: 'appr-c', toolName: 'bash', callId: CALL })
    const outcome = h.approve({ agent: h.child('child_1', 'sess_1'), toolName: 'bash', callId: CALL, reason: 'run rm' } as ApprovalRequestEvent)
    expect(h.bridge.pending('sess_1')).toEqual([expect.objectContaining({ id: 'appr-c', subagent_id: 'child_1', tool_name: 'bash' })])
    expect(h.onChange).toHaveBeenLastCalledWith('sess_1', [expect.objectContaining({ subagent_id: 'child_1' })])
    expect(h.bridge.answer('sess_1', 'appr-c', 'deny')).toBe('resolved')
    await expect(outcome).resolves.toBe('rejected')
  })

  it('keeps a child request through the parent turn end and cancels it at the child turn end', async () => {
    const h = bridgeHarness()
    const own = h.approve(request(h))
    const fromChild = h.approve({ agent: h.child('child_1', 'sess_1'), toolName: 'bash' } as ApprovalRequestEvent)
    expect(h.bridge.pending('sess_1')).toHaveLength(2)
    h.log('sess_1', 'turn/end', {})
    await expect(own).resolves.toBe('cancelled')
    expect(h.bridge.pending('sess_1')).toEqual([expect.objectContaining({ subagent_id: 'child_1' })])
    h.log('child_1', 'turn/end', {})
    await expect(fromChild).resolves.toBe('cancelled')
    expect(h.bridge.pending('sess_1')).toEqual([])
  })

  it('delegates a child whose parent is not claimed, and a child without the subagent origin', async () => {
    const h = bridgeHarness()
    await expect(h.approve({ agent: h.child('child_1', 'sess_other'), toolName: 'bash' } as ApprovalRequestEvent)).resolves.toBe('unavailable')
    const fork = { session: { id: 'fork_1', header: { parentSession: 'sess_1' } } } as never
    await expect(h.approve({ agent: fork, toolName: 'bash' } as ApprovalRequestEvent)).resolves.toBe('unavailable')
  })
})
