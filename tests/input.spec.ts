import { describe, expect, it } from 'vitest'
import {
  overlayAgent,
  parseToolArguments,
  textFromContent,
  toOAIUsage,
  userTextFromInput,
} from '../src/input.ts'
import { materializeAgent } from '../src/agent-store.ts'

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
