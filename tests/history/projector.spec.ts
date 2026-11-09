import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { materializeAgent } from '../../src/agent-records.ts'
import { WireProjector, foldSession, type ProjectionBase } from '../../src/history/projector.ts'
import { logEvent } from '../support/fake-session-query.ts'

function base(tools: ProjectionBase['agent']['tools'] = []): ProjectionBase {
  return {
    sessionId: 'sess_p',
    createdAt: 100,
    agent: materializeAgent({ model: 'deepseek-chat', tools }),
    environment: { type: 'none' },
    metadata: {},
    vaultIds: [],
  }
}

const userMessage = (seq: number) => logEvent('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, seq)
const assistant = (seq: number) => logEvent('assistant/message', {
  message: { content: [{ type: 'text', text: 'ok' }] },
  stream: [{ type: 'text-chunks', texts: ['o', 'k'] }],
}, seq)

/** One complete turn: start, user, assistant, end. */
function turnLog(first: number): SessionEvent[] {
  return [
    logEvent('turn/start', { turn: 1 }, first),
    userMessage(first + 1),
    assistant(first + 2),
    logEvent('turn/end', { reason: { kind: 'completed' }, usage: { inputTokens: 3, outputTokens: 2 } }, first + 3),
  ]
}

const types = (projector: WireProjector) => projector.frames.map(frame => frame.event.type)

describe('WireProjector', () => {
  it('numbers frames from 1 starting with agent.session.created', () => {
    const projector = new WireProjector(base(), true)
    expect(projector.created).toMatchObject({ id: 1, event: { type: 'agent.session.created', event_id: 'evt_sess_p_1' } })
    expect(projector.nextId).toBe(2)
  })

  it('fold equals incremental application, with ids 1..n', () => {
    const events = [...turnLog(1), ...turnLog(5)]
    const shared = base()
    const folded = foldSession(shared, events)
    const live = new WireProjector(shared, true)
    const liveFrames = events.flatMap(event => live.apply(event).frames)

    expect(folded.frames.slice(1)).toEqual(liveFrames)
    expect(folded.frames.map(frame => frame.id)).toEqual(folded.frames.map((_, index) => index + 1))
    expect(folded.frames.every(frame => frame.event.event_id === `evt_sess_p_${String(frame.id)}`)).toBe(true)
    expect(folded.items).toEqual(live.items)
    expect(folded.turns.map(turn => turn.id)).toEqual(['turn_1', 'turn_5'])
  })

  it('projects scheduled prompts the same live and replayed, and skips change notices', () => {
    const reminder = logEvent('user/message', {
      content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nschedule_id_json: "schedule-a"\nreminder_prompt_json: "Check the build"' }],
      source: { kind: 'schedule' },
    }, 2)
    const notice = logEvent('user/message', {
      content: [{ type: 'text', text: '[SCHEDULE CHANGE]\nchange: updated' }],
      source: { kind: 'schedule' },
    }, 3)
    const events = [logEvent('turn/start', { turn: 1 }, 1), reminder, notice, assistant(4), logEvent('turn/end', { reason: { kind: 'completed' } }, 5)]
    const shared = base()
    const live = new WireProjector(shared, true)
    for (const event of events) live.apply(event)
    const folded = foldSession(shared, events)
    expect(folded.items).toEqual(live.items)
    expect(folded.items.map(item => item.type === 'message' ? [item.role, item.source ?? null, item.turn_id] : item.type)).toEqual([
      ['user', 'schedule', 'turn_1'],
      ['assistant', null, 'turn_1'],
    ])
    expect(folded.items[0]).toMatchObject({ content: [{ text: 'Check the build' }], schedule_id: 'schedule-a' })
  })

  it('ids are deterministic across folds', () => {
    const events = turnLog(1)
    const shared = base()
    expect(foldSession(shared, events).frames).toEqual(foldSession(shared, events).frames)
  })

  it('projects a completed turn with usage and returns the session to idle', () => {
    const projector = foldSession(base(), turnLog(1))
    expect(types(projector)).toEqual([
      'agent.session.created',
      'agent.session.in_progress',
      'agent.session.turn.created',
      'agent.session.turn.in_progress',
      'agent.session.turn.item.added',
      'agent.session.turn.output_text.delta',
      'agent.session.turn.output_text.delta',
      'agent.session.turn.output_text.done',
      'agent.session.turn.item.done',
      'agent.session.turn.completed',
      'agent.session.idle',
    ])
    expect(projector.status).toBe('idle')
    expect(projector.turns[0]).toMatchObject({ id: 'turn_1', status: 'completed', created_at: 1, completed_at: 4 })
    expect(projector.usage).toMatchObject({ input_tokens: 3, output_tokens: 2 })
    expect(projector.items.map(item => item.type)).toEqual(['message', 'message'])
  })

  it('emits a single delta when the assistant stream is empty', () => {
    const projector = foldSession(base(), [
      logEvent('turn/start', { turn: 1 }, 1),
      logEvent('assistant/message', { message: { content: 'only-body' } }, 2),
    ])
    const deltas = projector.frames.flatMap(frame => frame.event.type === 'agent.session.turn.output_text.delta' ? [frame.event.delta] : [])
    expect(deltas).toEqual(['only-body'])
  })

  it('aborted turn/end emits turn.cancelled and no error', () => {
    const projector = foldSession(base(), [
      logEvent('turn/start', { turn: 1 }, 1),
      logEvent('turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } }, 2),
    ])
    expect(types(projector).slice(-2)).toEqual(['agent.session.turn.cancelled', 'agent.session.idle'])
    expect(projector.turns[0]).toMatchObject({ status: 'cancelled', error: null })
    expect(projector.status).toBe('idle')
  })

  it('interrupted turn/end becomes a cancelled turn with code interrupted and an idle session', () => {
    const projector = foldSession(base(), [
      logEvent('turn/start', { turn: 1 }, 1),
      logEvent('turn/end', { reason: { kind: 'interrupted' } }, 2),
    ])
    expect(projector.turns[0]).toMatchObject({
      status: 'cancelled',
      error: { code: 'interrupted', message: 'Turn interrupted by a server restart' },
    })
    expect(projector.status).toBe('idle')
    expect(projector.error).toBeNull()
  })

  it('error turn/end fails the turn and the session', () => {
    const step = new WireProjector(base(), true)
    step.apply(logEvent('turn/start', { turn: 1 }, 1))
    const result = step.apply(logEvent('turn/end', { reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE' } } }, 2))
    expect(result.status).toEqual({ status: 'failed', error: 'rate limited' })
    expect(step.turns[0]).toMatchObject({ status: 'failed', error: { code: 'RATE', message: 'rate limited' } })
    expect(step.snapshot()).toMatchObject({ status: 'failed', error: 'rate limited' })
    // A later turn clears the error.
    expect(step.apply(logEvent('turn/start', { turn: 2 }, 3)).status).toEqual({ status: 'in_progress', error: null })
  })

  it('a function tool call emits requires_action and its result clears it', () => {
    const projector = new WireProjector(base([{ type: 'function', name: 'get_weather' }]), true)
    projector.apply(logEvent('turn/start', { turn: 1 }, 1))
    const call = projector.apply(logEvent('tool/call', { callId: 'call_w', name: 'get_weather', arguments: '{"city":"SF"}' }, 2))
    expect(call.status).toEqual({ status: 'requires_action', error: null })
    expect(call.frames.map(frame => frame.event.type)).toEqual(['agent.session.requires_action'])
    expect(projector.snapshot().required_actions).toEqual([{
      type: 'function_call',
      name: 'get_weather',
      arguments: { city: 'SF' },
      turn_id: 'turn_1',
      call_id: 'call_w',
    }])

    const result = projector.apply(logEvent('tool/result', {
      message: { source: { kind: 'tool', callId: 'call_w' }, content: [{ type: 'text', text: '68F' }] },
    }, 3))
    expect(result.status).toEqual({ status: 'in_progress', error: null })
    expect(result.frames).toEqual([])
    expect(projector.snapshot()).toMatchObject({ status: 'in_progress', required_actions: [] })
    expect(projector.items.map(item => item.type)).toEqual(['function_call', 'function_call_output'])
  })

  it('does not park calls to tools that are not wire function tools', () => {
    const projector = new WireProjector(base([{ type: 'function', name: 'get_weather' }]), true)
    projector.apply(logEvent('turn/start', { turn: 1 }, 1))
    const call = projector.apply(logEvent('tool/call', { callId: 'c', name: 'web_search', arguments: '{}' }, 2))
    expect(call.frames).toEqual([])
    expect(call.status).toBeUndefined()
    expect(projector.status).toBe('in_progress')
    expect(projector.items).toHaveLength(1)
  })

  it('a turn that ends with a call parked drops its required action', () => {
    const projector = new WireProjector(base([{ type: 'function', name: 'f' }]), true)
    projector.apply(logEvent('turn/start', { turn: 1 }, 1))
    projector.apply(logEvent('tool/call', { callId: 'c', name: 'f', arguments: '{}' }, 2))
    projector.apply(logEvent('tool/result', { message: { source: { kind: 'tool', callId: 'other' }, content: [] } }, 3))
    expect(projector.snapshot().required_actions).toHaveLength(1)
    projector.apply(logEvent('turn/end', { reason: { kind: 'interrupted' } }, 4))
    expect(projector.snapshot()).toMatchObject({ status: 'idle', required_actions: [] })
  })

  it('unknown event types emit no frames and leave ids and activity time unchanged', () => {
    const projector = new WireProjector(base(), true)
    const before = projector.nextId
    const step = projector.apply(logEvent('step/start', { turn: 1, step: 1 }, 9))
    expect(step).toEqual({ frames: [] })
    expect(projector.nextId).toBe(before)
    expect(projector.lastActiveAt).toBe(100)
  })

  it('turn/end without an open turn only returns the session to idle', () => {
    const projector = foldSession(base(), [logEvent('turn/end', { reason: { kind: 'completed' } }, 1)])
    expect(types(projector)).toEqual(['agent.session.created', 'agent.session.idle'])
  })

  it('refuses to list frames when built without retainFrames', () => {
    expect(() => new WireProjector(base(), false).frames).toThrow(/retainFrames/)
  })

  it('shows a settings change in later snapshots, not in frames already produced', () => {
    const projector = new WireProjector(base(), true)
    projector.base = { ...projector.base, metadata: { n: '1' } }
    expect(projector.snapshot().metadata).toEqual({ n: '1' })
    expect(projector.created.event).toMatchObject({ session: { metadata: {} } })
  })
})
