import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { applyHostToolsRestrict, validateHostTools } from '../src/host-tools.ts'

describe('validateHostTools', () => {
  it('accepts absent, null, allow, deny, and both', () => {
    expect(validateHostTools(undefined)).toBeUndefined()
    expect(validateHostTools(null)).toBeUndefined()
    expect(validateHostTools({ allow: ['web_fetch'] })).toBeUndefined()
    expect(validateHostTools({ deny: ['web_search'] })).toBeUndefined()
    expect(validateHostTools({ allow: [], deny: ['bash'] })).toBeUndefined()
  })

  it('rejects empty objects and non-string arrays', () => {
    expect(validateHostTools({})).toMatch(/allow and\/or deny/)
    expect(validateHostTools({ allow: null, deny: null })).toMatch(/allow and\/or deny/)
    expect(validateHostTools({ allow: [1] as never })).toMatch(/allow must be an array/)
    expect(validateHostTools({ deny: 'web_search' as never })).toMatch(/deny must be an array/)
  })
})

describe('applyHostToolsRestrict', () => {
  it('calls tools.restrict with allow and/or deny', () => {
    const restrict = vi.fn()
    const agentCtx = { tools: { restrict } } as unknown as Context
    applyHostToolsRestrict(agentCtx, undefined)
    applyHostToolsRestrict(agentCtx, null)
    applyHostToolsRestrict(agentCtx, {})
    expect(restrict).not.toHaveBeenCalled()

    applyHostToolsRestrict(agentCtx, { deny: ['web_search'] })
    expect(restrict).toHaveBeenLastCalledWith({ deny: ['web_search'] })

    applyHostToolsRestrict(agentCtx, { allow: ['web_fetch'], deny: ['bash'] })
    expect(restrict).toHaveBeenLastCalledWith({ allow: ['web_fetch'], deny: ['bash'] })
  })
})
