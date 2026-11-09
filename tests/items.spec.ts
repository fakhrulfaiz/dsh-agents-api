import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { itemsFromEvent, slashCommandItem } from '../src/items.ts'

function event(type: SessionEvent['type'], data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

describe('itemsFromEvent', () => {
  it('projects user, assistant, shell, function, and result events', () => {
    expect(itemsFromEvent(event('user/message', {
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), 'turn_1')).toMatchObject([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
    expect(itemsFromEvent(event('user/message', {
      content: [{ type: 'text', text: '<system-reminder>workspace</system-reminder>' }],
      source: { kind: 'plugin' },
    }), 'turn_1')).toEqual([])

    const assistant = itemsFromEvent(event('assistant/message', {
      message: { content: [{ type: 'text', text: 'ok' }] },
      stream: [{ type: 'reasoning-chunks', texts: ['think'] }, { type: 'text-chunks', texts: ['ok'] }],
    }), 'turn_1')
    expect(assistant.map(item => item.type)).toEqual(['reasoning', 'message'])

    const cmd = itemsFromEvent(event('tool/call', {
      name: 'bash',
      callId: 'c1',
      arguments: '{"command":"ls","cwd":"/tmp"}',
    }), 'turn_1')
    expect(cmd).toMatchObject([{ type: 'command_execution', command: 'ls', cwd: '/tmp' }])
    expect(itemsFromEvent(event('tool/call', {
      name: 'pwsh',
      arguments: '{"cmd":"Get-ChildItem"}',
    }), 'turn_1')).toMatchObject([{ type: 'command_execution', command: 'Get-ChildItem' }])
    expect(itemsFromEvent(event('tool/call', { name: 'bash', arguments: '{"command":{"nested":1}}' }), 'turn_1')).toMatchObject([
      { type: 'command_execution', command: '' },
    ])

    const fn = itemsFromEvent(event('tool/call', {
      name: 'lookup',
      callId: 'c2',
      arguments: '{"q":1}',
    }), 'turn_1')
    expect(fn).toMatchObject([{ type: 'function_call', name: 'lookup', call_id: 'c2', arguments: { q: 1 }, status: 'in_progress' }])

    const result = itemsFromEvent(event('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'c2' },
        content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'done' }] }],
      },
    }), 'turn_1')
    expect(result).toMatchObject([{ type: 'function_call_output', call_id: 'c2', output: 'done', status: 'completed' }])

    const failed = itemsFromEvent(event('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'c3' },
        content: [{ type: 'tool-result', toolCallId: 'c3', isError: true, content: [{ type: 'text', text: 'boom' }] }],
      },
    }), 'turn_1')
    expect(failed).toMatchObject([{ type: 'function_call_output', call_id: 'c3', status: 'failed', error: 'boom' }])
  })

  it('falls back when call identities are missing and ignores other events', () => {
    expect(itemsFromEvent(event('tool/call', {}), 'turn_1')[0]).toMatchObject({
      type: 'function_call',
      name: 'unknown_tool',
    })
    expect(itemsFromEvent(event('tool/call', { name: 3, callId: 9 }), 'turn_1')[0]).toMatchObject({
      type: 'function_call',
      name: 'unknown_tool',
      call_id: 'call_1',
    })
    expect(itemsFromEvent(event('tool/result', { message: { content: 'raw' } }), 'turn_1')[0]).toMatchObject({
      type: 'function_call_output',
      output: 'raw',
    })
    expect(itemsFromEvent(event('tool/result', { message: { callId: 'direct', content: [] } }), 'turn_1')[0]).toMatchObject({
      call_id: 'direct',
    })
    expect(itemsFromEvent(event('tool/result', {
      message: { content: [{ toolCallId: 'from-block', content: [{ type: 'text', text: 'x' }] }] },
    }), 'turn_1')[0]).toMatchObject({ call_id: 'from-block', output: 'x' })
    expect(itemsFromEvent(event('turn/start', { turn: 1 }), 'turn_1')).toEqual([])
    expect(itemsFromEvent(event('assistant/message', {
      message: { content: 'ok' },
      stream: [{ type: 'reasoning-chunks', texts: [] }],
    }), 'turn_1')).toHaveLength(1)
    expect(itemsFromEvent(event('assistant/message', { message: { content: 'ok' } }), 'turn_1')).toHaveLength(1)
    expect(itemsFromEvent(event('tool/call', {
      name: 'terminal',
      arguments: '{"command":"echo"}',
    }), 'turn_1')).toMatchObject([{ type: 'command_execution', command: 'echo' }])
    expect(itemsFromEvent(event('tool/result', {}), 'turn_1')[0]).toMatchObject({
      call_id: 'call_1',
    })
    expect(itemsFromEvent(event('tool/result', {
      message: { content: [{ type: 'text', text: 'x' }] },
    }), 'turn_1')[0]).toMatchObject({ call_id: 'call_1', output: 'x' })
  })
})

describe('itemsFromEvent for scheduled prompts', () => {
  const scheduled = (text: string) => event('user/message', { content: [{ type: 'text', text }], source: { kind: 'schedule' } }, 7)
  const reminder = (prompt: string) => [
    '[SCHEDULE REMINDER]',
    'This is a scheduled message from the user',
    'schedule_id_json: "schedule-abc"',
    'occurrence_at: 2026-11-11T08:00:00.000Z',
    `reminder_prompt_json: ${JSON.stringify(prompt)}`,
  ].join('\n')

  it('projects a single reminder as a user message with the extracted prompt', () => {
    expect(itemsFromEvent(scheduled(reminder('Summarize the news\nin three lines')), 'turn_2')).toEqual([{
      id: 'item_msg_7',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Summarize the news\nin three lines' }],
      source: 'schedule',
      schedule_id: 'schedule-abc',
      status: 'completed',
      turn_id: 'turn_2',
    }])
  })

  it('projects a reminder batch with the prompts joined and no task id for several tasks', () => {
    const batch = (reminders: object[]) => ['[SCHEDULE REMINDER BATCH]', 'This is a scheduled message from the user', `reminders_json: ${JSON.stringify(reminders)}`].join('\n')
    const two = itemsFromEvent(scheduled(batch([
      { schedule_id: 'schedule-a', occurrence_at: '2026-11-11T08:00:00.000Z', reminder_prompt: 'First' },
      { schedule_id: 'schedule-b', occurrence_at: '2026-11-11T08:00:00.000Z', reminder_prompt: 'Second' },
    ])), 'turn_2')
    expect(two).toMatchObject([{ content: [{ type: 'input_text', text: 'First\n\nSecond' }], source: 'schedule' }])
    expect(two[0]).not.toHaveProperty('schedule_id')
    expect(itemsFromEvent(scheduled(batch([{ schedule_id: 'schedule-a', occurrence_at: 'x', reminder_prompt: 'Only' }])), 'turn_2')).toMatchObject([
      { content: [{ type: 'input_text', text: 'Only' }], schedule_id: 'schedule-a' },
    ])
  })

  it.each([
    ['a reminder prompt line that is not JSON', '[SCHEDULE REMINDER]\nreminder_prompt_json: {nope'],
    ['a reminder without a prompt line', '[SCHEDULE REMINDER]\nThis is a scheduled message from the user'],
    ['a reminder prompt that is not a string', '[SCHEDULE REMINDER]\nreminder_prompt_json: 42'],
    ['a batch that is not JSON', '[SCHEDULE REMINDER BATCH]\nreminders_json: [oops'],
    ['an empty batch', '[SCHEDULE REMINDER BATCH]\nreminders_json: []'],
    ['a batch entry without a prompt', '[SCHEDULE REMINDER BATCH]\nreminders_json: [{"schedule_id":"a"}]'],
  ])('falls back to the full text for %s', (_name, text) => {
    expect(itemsFromEvent(scheduled(text), 'turn_2')).toMatchObject([{ content: [{ type: 'input_text', text }], source: 'schedule' }])
  })

  it('shows no item for schedule change notices or other schedule-sourced input', () => {
    const notice = ['[SCHEDULE CHANGE]', 'A scheduled task involving this session was changed outside this session.', 'change: updated'].join('\n')
    expect(itemsFromEvent(scheduled(notice), 'turn_2')).toEqual([])
    expect(itemsFromEvent(scheduled('anything else'), 'turn_2')).toEqual([])
  })
})

describe('slashCommandItem', () => {
  it('maps a success to completed and a blank args string to no args', () => {
    expect(slashCommandItem({ seq: 4, commandId: 'c', name: 'goal', args: '  ' }, { kind: 'success', text: 'ok' }, 'turn_1'))
      .toEqual({ id: 'item_cmd_4', type: 'slash_command', command_id: 'c', name: 'goal', status: 'completed', text: 'ok', turn_id: 'turn_1' })
  })
  it('maps an error to failed', () => {
    expect(slashCommandItem({ seq: 4, commandId: 'c', name: 'goal', args: 'edit x' }, { kind: 'error', text: 'no' }, null))
      .toMatchObject({ status: 'failed', args: 'edit x', turn_id: null })
  })
})
