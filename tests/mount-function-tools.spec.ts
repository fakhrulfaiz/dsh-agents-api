import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mountFunctionTools, validateMountableTools } from '../src/mount-function-tools.ts'
import type { PendingFunctionCalls } from '../src/pending-function-calls.ts'

describe('validateMountableTools', () => {
  it('accepts function tools and rejects unsupported entries', () => {
    expect(validateMountableTools([])).toBeUndefined()
    expect(validateMountableTools([{ type: 'function', name: 'a' }])).toBeUndefined()
    expect(validateMountableTools([{ type: 'web_search' }])).toMatch(/web_search/)
    expect(validateMountableTools([{ type: 'function', name: '' }])).toMatch(/non-empty name/)
    expect(validateMountableTools([{ type: 'function', name: 'a', defer_loading: true }])).toMatch(/defer_loading/)
  })
})

describe('mountFunctionTools', () => {
  it('registers parked tools that forward to the pending registry', async () => {
    const registered: Array<{ name: string; execute: (args: unknown, exec: { callId: string; signal: AbortSignal }) => Promise<unknown> }> = []
    const agentCtx = {
      tools: {
        register: (definition: { name: string; execute: (args: unknown, exec: { callId: string; signal: AbortSignal }) => Promise<unknown> }) => {
          registered.push(definition)
          return () => undefined
        },
      },
    } as unknown as Context
    const wait = vi.fn(async () => 'result')
    const pending = { wait } as unknown as PendingFunctionCalls

    mountFunctionTools(
      agentCtx,
      [{ type: 'function', name: 'lookup', description: 'Find things', parameters: { type: 'object', properties: {} } }],
      pending,
      () => 'turn_x',
    )
    expect(registered).toHaveLength(1)
    expect(registered[0]!.name).toBe('lookup')
    await expect(registered[0]!.execute({ q: 1 }, {
      callId: 'c1',
      signal: new AbortController().signal,
    })).resolves.toBe('result')
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'c1',
      name: 'lookup',
      arguments: { q: 1 },
      turnId: 'turn_x',
    }))
  })
})
