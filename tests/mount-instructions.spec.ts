import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AGENTS_API_GUIDANCE_ORDER,
  AGENTS_API_GUIDANCE_SECTION,
  AGENTS_API_GUIDANCE_TEXT,
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

    const guidance = {
      name: AGENTS_API_GUIDANCE_SECTION,
      order: AGENTS_API_GUIDANCE_ORDER,
      text: AGENTS_API_GUIDANCE_TEXT,
    }

    mountAgentInstructions(agentCtx, null)
    mountAgentInstructions(agentCtx, '   ')
    expect(sections).toEqual([guidance, guidance])
    sections.length = 0
    mountAgentInstructions(agentCtx, '  be brief  ')

    expect(sections).toEqual([{
      name: AGENTS_API_INSTRUCTIONS_SECTION,
      order: AGENTS_API_INSTRUCTIONS_ORDER,
      text: 'be brief',
    }, guidance])
  })

  it('fails session setup when the Host has no system prompt', () => {
    const agentCtx = {
      get: () => undefined,
    } as unknown as Context
    expect(() => mountAgentInstructions(agentCtx, 'be brief')).toThrow(/systemPrompt/)
  })
})

describe('saved agent identity line', () => {
  const capture = () => {
    const sections: Array<{ name: string; order: number; text: string }> = []
    const agentCtx = {
      get: (name: string) => name === 'systemPrompt' ? {} : undefined,
      systemPrompt: { section: (section: { name: string; order: number; text: string }) => { sections.push(section) } },
    } as unknown as Context
    return { sections, agentCtx }
  }

  it('registers the saved agent identity line', () => {
    const { sections, agentCtx } = capture()
    mountAgentInstructions(agentCtx, 'Be brief.', 'Research Assistant')
    expect(sections).toContainEqual({ name: 'agents-api:identity', order: 9, text: 'You are Research Assistant, an agent built on Agentry. When asked who or what you are, introduce yourself as Research Assistant, an agent built on Agentry.' })
  })

  it('adds no identity section without a name', () => {
    const { sections, agentCtx } = capture()
    mountAgentInstructions(agentCtx, 'Be brief.', null)
    expect(sections.map(s => s.name)).not.toContain('agents-api:identity')
  })
})
