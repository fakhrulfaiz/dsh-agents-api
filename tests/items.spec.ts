import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { itemsFromEvent } from '../src/items.ts'

function event(type: SessionEvent['type'], data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

describe('itemsFromEvent', () => {
  it('projects user, assistant, shell, function, and result events', () => {
    expect(itemsFromEvent(event('user/message', { content: [{ type: 'text', text: 'hi' }] }), 'turn_1')).toMatchObject([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])

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
    expect(fn).toMatchObject([{ type: 'function_call', name: 'lookup', call_id: 'c2', arguments: { q: 1 } }])

    const result = itemsFromEvent(event('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'c2' },
        content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'done' }] }],
      },
    }), 'turn_1')
    expect(result).toMatchObject([{ type: 'function_call_output', call_id: 'c2', output: 'done' }])
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
