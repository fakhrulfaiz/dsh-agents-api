import { describe, expect, it } from 'vitest'
import {
  overlayAgent,
  parseApprovalResponse,
  parseToolArguments,
  textFromContent,
  toOAIUsage,
  userTextFromInput,
} from '../src/input.ts'
import { materializeAgent } from '../src/agent-records.ts'

describe('userTextFromInput', () => {
  it('flattens strings, message arrays, and unknown JSON', () => {
    expect(userTextFromInput(undefined)).toBeUndefined()
    expect(userTextFromInput('hello')).toBe('hello')
    expect(userTextFromInput([
      { role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] },
    ])).toBe('a\nb')
    expect(userTextFromInput([{ role: 'user' } as never])).toBe('')
    expect(userTextFromInput([
      { role: 'user', content: [{ type: 'input_file' }, { type: 'input_text', text: 'kept' }] },
    ])).toBe('kept')
    expect(userTextFromInput({ x: 1 } as never)).toBe('{"x":1}')
  })
})

describe('parseToolArguments', () => {
  it('parses JSON strings and objects, and wraps invalid values', () => {
    expect(parseToolArguments('{"command":"ls"}')).toEqual({ command: 'ls' })
    expect(parseToolArguments('{')).toEqual({ raw: '{' })
    expect(parseToolArguments('[1]')).toEqual({ raw: '[1]' })
    expect(parseToolArguments({ cmd: 'pwd' })).toEqual({ cmd: 'pwd' })
    expect(parseToolArguments(null)).toEqual({})
    expect(parseToolArguments(3)).toEqual({})
  })
})

describe('textFromContent', () => {
  it('joins text and nested tool-result blocks', () => {
    expect(textFromContent('plain')).toBe('plain')
    expect(textFromContent(null)).toBe('')
    expect(textFromContent({ a: 1 })).toBe('{"a":1}')
    expect(textFromContent([
      { type: 'text', text: 'hi' },
      { type: 'tool-result', content: [{ type: 'text', text: 'out' }] },
      { type: 'tool-result', content: 'skip-non-array' },
      'skip',
    ])).toBe('hiout')
  })
})

describe('overlayAgent', () => {
  it('replaces supplied fields and keeps omitted ones', () => {
    const base = materializeAgent({ model: 'deepseek-chat', instructions: 'base', tools: [] })
    const overlaid = overlayAgent(base, {
      model: 'deepseek-v4-flash',
      instructions: 'override',
      name: 'n',
      metadata: { k: 'v' },
      tools: [{ type: 'web_search' }],
      host_tools: { deny: ['bash'] },
      multi_agent: { enabled: true },
      reasoning: { effort: 'low' },
      service_tier: 'flex',
      text: { verbosity: 'low' },
    })
    expect(overlaid.model).toBe('deepseek-v4-flash')
    expect(overlaid.instructions).toBe('override')
    expect(overlaid.name).toBe('n')
    expect(overlaid.host_tools).toEqual({ deny: ['bash'] })
    expect(overlaid.id).toBe(base.id)
    expect(overlayAgent(base, { metadata: null, tools: null }).tools).toEqual([])
    expect(overlayAgent(base, {}).instructions).toBe('base')
    expect(overlayAgent(base, { host_tools: null }).host_tools).toBeNull()
  })
})

describe('toOAIUsage', () => {
  it('projects DSH usage, including cache and reasoning', () => {
    expect(toOAIUsage(undefined)).toBeNull()
    expect(toOAIUsage({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 1,
      totalTokens: 10,
    })).toEqual({
      input_tokens: 6,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 10,
    })
    expect(toOAIUsage({ inputTokens: 1, outputTokens: 2 })?.total_tokens).toBe(3)
  })
})

describe('parseApprovalResponse', () => {
  it('accepts the three decisions and keeps a payload', () => {
    expect(parseApprovalResponse({ type: 'agent.session.input.approval_response', id: 'a', decision: 'answer', payload: { selected: ['x'] } }))
      .toEqual({ type: 'agent.session.input.approval_response', id: 'a', decision: 'answer', payload: { selected: ['x'] } })
    expect(parseApprovalResponse({ id: 'a', decision: 'deny' })).toEqual({ type: 'agent.session.input.approval_response', id: 'a', decision: 'deny' })
  })

  it('rejects a missing id and an unknown decision with 400', () => {
    expect(() => parseApprovalResponse({ decision: 'approve' })).toThrow(expect.objectContaining({ status: 400, code: 'invalid_approval_response' }))
    expect(() => parseApprovalResponse({ id: '', decision: 'approve' })).toThrow(expect.objectContaining({ code: 'invalid_approval_response' }))
    expect(() => parseApprovalResponse({ id: 'a', decision: 'allow' })).toThrow(expect.objectContaining({ code: 'invalid_approval_response' }))
  })
})

describe('fileIdsFromInput', () => {
  it('collects file ids in order and ignores text and strings', async () => {
    const { fileIdsFromInput } = await import('../src/input.ts')
    expect(fileIdsFromInput('hi')).toEqual([])
    expect(fileIdsFromInput(undefined)).toEqual([])
    expect(fileIdsFromInput([
      { role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', file_id: 'file_a' }] },
      { role: 'user', content: [{ type: 'input_file', file_id: 'file_b', filename: 'ignored' }] },
    ])).toEqual(['file_a', 'file_b'])
  })

  it.each([
    { type: 'input_image', image_url: 'https://x/y.png' },
    { type: 'input_image', file_id: 'file_a', image_url: 'data:image/png;base64,AAAA' },
    { type: 'input_file', file_data: 'AAAA' },
    { type: 'input_file', file_url: 'https://x/y.pdf' },
    { type: 'input_file' },
    { type: 'input_image', file_id: '' },
  ])('rejects %j', async (part) => {
    const { fileIdsFromInput } = await import('../src/input.ts')
    expect(() => fileIdsFromInput([{ role: 'user', content: [part] }])).toThrow(expect.objectContaining({ status: 400, code: 'unsupported_content_part' }))
  })
})
