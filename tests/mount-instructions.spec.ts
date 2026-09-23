import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AGENTS_API_INSTRUCTIONS_ORDER,
  AGENTS_API_INSTRUCTIONS_SECTION,
  mountAgentInstructions,
} from '../src/mount-instructions.ts'

describe('mountAgentInstructions', () => {
  it('registers non-empty instructions and skips blank text', () => {
    const sections: Array<{ name: string; order: number; text: string }> = []
    const agentCtx = {
      get: (name: string) => name === 'systemPrompt' ? {} : undefined,
      systemPrompt: {
        section: (section: { name: string; order: number; text: string }) => {
          sections.push(section)
        },
      },
    } as unknown as Context

    mountAgentInstructions(agentCtx, null)
    mountAgentInstructions(agentCtx, '   ')
    mountAgentInstructions(agentCtx, '  be brief  ')

    expect(sections).toEqual([{
      name: AGENTS_API_INSTRUCTIONS_SECTION,
      order: AGENTS_API_INSTRUCTIONS_ORDER,
      text: 'be brief',
    }])
  })

  it('fails session setup when the Host has no system prompt', () => {
    const agentCtx = {
      get: () => undefined,
    } as unknown as Context
    expect(() => mountAgentInstructions(agentCtx, 'be brief')).toThrow(/systemPrompt/)
  })
})
