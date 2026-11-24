import { describe, expect, it } from 'vitest'
import { materializeAgent } from '../../src/agent-records.ts'
import { WireProjector, foldSession, type ProjectionBase } from '../../src/history/projector.ts'
import { logEvent } from '../support/fake-session-query.ts'

const base = (): ProjectionBase => ({
  sessionId: 'sess_t',
  createdAt: 100,
  agent: materializeAgent({ model: 'deepseek-chat', tools: [] }),
  environment: { type: 'none' },
  metadata: {},
  vaultIds: [],
})

/** One turn: a step that thinks, answers and calls a tool, the tool result, then a final step. */
const events = [
  logEvent('turn/start', { turn: 1 }, 1, 10_000),
  logEvent('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, 2, 10_010),
  logEvent('step/start', { turn: 1, step: 1 }, 3, 10_100),
  logEvent('assistant/message', {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: 'looking' }] },
    stream: [
      { type: 'reasoning-chunks', time0: 10_400, index: 0, dt: [0, 50], texts: ['let ', 'me'] },
      { type: 'text-chunks', time0: 10_600, index: 1, dt: [0], texts: ['looking'] },
    ],
    usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 8 },
  }, 4, 10_900),
  logEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{"q":"x"}' }, 5, 10_950),
  logEvent('tool/result', {
    turn: 1,
    step: 1,
    message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'found' }] }] },
  }, 6, 12_000),
  logEvent('step/start', { turn: 1, step: 2 }, 7, 12_050),
  logEvent('assistant/message', {
    turn: 1,
    step: 2,
    message: { content: [{ type: 'text', text: 'done' }] },
    stream: [{ type: 'text-chunks', time0: 12_300, index: 0, dt: [0], texts: ['done'] }],
  }, 8, 12_500),
  logEvent('turn/end', { reason: { kind: 'completed' } }, 9, 12_600),
]

describe('item timing', () => {
  const items = foldSession(base(), events).items
  const byId = (id: string) => items.find(item => item.id === id)

  it('times an assistant step from its start, with first token, end, step number and usage', () => {
    expect(byId('item_msg_4')).toMatchObject({
      step: 1,
      timing: { started_at_ms: 10_100, first_token_at_ms: 10_400, completed_at_ms: 10_900 },
      usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 8 } },
    })
    expect(byId('item_reason_4')).toMatchObject({ step: 1, timing: { started_at_ms: 10_100, first_token_at_ms: 10_400, completed_at_ms: 10_900 } })
    expect(byId('item_msg_8')).toMatchObject({ step: 2, timing: { started_at_ms: 12_050, first_token_at_ms: 12_300, completed_at_ms: 12_500 } })
    expect(byId('item_msg_8')).not.toHaveProperty('usage')
  })

  it('times a tool call from its call to its result', () => {
    expect(byId('item_fn_5')).toMatchObject({ step: 1, timing: { started_at_ms: 10_950, completed_at_ms: 12_000 } })
    expect(byId('item_fn_out_6')).toMatchObject({ timing: { completed_at_ms: 12_000 } })
  })

  it('stamps a user message with when it was logged', () => {
    expect(byId('item_msg_2')).toMatchObject({ timing: { completed_at_ms: 10_010 } })
  })

  it('gives the same timing live and replayed, and leaves a running call without an end', () => {
    const live = new WireProjector(base(), true)
    for (const event of events.slice(0, 5)) live.apply(event)
    expect(live.items.find(item => item.id === 'item_fn_5')).toMatchObject({ timing: { started_at_ms: 10_950 } })
    expect((live.items.find(item => item.id === 'item_fn_5') as { timing?: object } | undefined)?.timing).not.toHaveProperty('completed_at_ms')
    for (const event of events.slice(5)) live.apply(event)
    expect(live.items).toEqual(items)
  })

  it('falls back to the first stream time when the step start is not in the log', () => {
    const noStep = foldSession(base(), events.filter(event => event.type !== 'step/start')).items
    expect(noStep.find(item => item.id === 'item_msg_4')).toMatchObject({ timing: { started_at_ms: 10_400, first_token_at_ms: 10_400 } })
  })
})
