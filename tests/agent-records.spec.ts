import { describe, expect, it } from 'vitest'
import { materializeAgent, updatedAgent } from '../src/agent-records.ts'

describe('agent records', () => {
  it('materializes every create field', () => {
    const agent = materializeAgent({
      model: 'deepseek-chat',
      name: 'coder',
      instructions: 'be brief',
      tools: [],
      reasoning: { effort: 'low' },
      multi_agent: { enabled: true },
      service_tier: 'flex',
      text: { verbosity: 'low' },
    })
    expect(agent).toMatchObject({
      object: 'agent',
      name: 'coder',
      instructions: 'be brief',
      metadata: {},
      reasoning: { effort: 'low' },
      multi_agent: { enabled: true },
      service_tier: 'flex',
      text: { verbosity: 'low' },
    })
    expect(agent.id.startsWith('agent_')).toBe(true)
    expect(materializeAgent({ model: 'm' })).toMatchObject({ name: null, instructions: null, tools: [], metadata: {} })
  })

  it('merges updates: omitted fields keep their values, supplied objects replace them, null clears', () => {
    const agent = materializeAgent({ model: 'deepseek-chat', name: 'coder', instructions: 'be brief' })
    expect(updatedAgent(agent, { model: 'deepseek-v4-flash' })).toMatchObject({ name: 'coder', model: 'deepseek-v4-flash' })
    const updated = updatedAgent(agent, {
      name: 'reviewer',
      instructions: 'review',
      reasoning: { effort: 'high' },
      metadata: { a: '1', b: '2' },
    })
    expect(updated).toMatchObject({ name: 'reviewer', instructions: 'review', reasoning: { effort: 'high' } })
    expect(updatedAgent(updated, { metadata: { b: '3' } }).metadata).toEqual({ b: '3' })
    expect(updatedAgent(updated, { metadata: null, tools: null })).toMatchObject({ metadata: {}, tools: [] })
    expect(updatedAgent(updated, { tools: [{ type: 'web_search' }] }).tools).toEqual([{ type: 'web_search' }])
    expect(updatedAgent(updated, { host_tools: { deny: ['web_search'] } }).host_tools).toEqual({ deny: ['web_search'] })
    expect(updatedAgent(updated, { host_tools: null }).host_tools).toBeNull()
    expect(updatedAgent(agent, {}).id).toBe(agent.id)
  })
})
