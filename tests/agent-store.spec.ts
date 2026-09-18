import { describe, expect, it } from 'vitest'
import { AgentStore } from '../src/agent-store.ts'

describe('AgentStore', () => {
  it('creates, updates, lists, and deletes saved agents', () => {
    const store = new AgentStore()
    const agent = store.create({
      model: 'deepseek-chat',
      name: 'coder',
      instructions: 'be brief',
      tools: [],
      reasoning: { effort: 'low' },
      multi_agent: { enabled: true },
      service_tier: 'flex',
      text: { verbosity: 'low' },
    })
    store.create({ model: 'deepseek-chat', name: 'second' })
    expect(store.list({ limit: 20, order: 'asc' }).data).toHaveLength(2)
    expect(store.update(agent.id, { model: 'deepseek-v4-flash' })?.name).toBe('coder')
    expect(store.get(agent.id)?.name).toBe('coder')
    const updated = store.update(agent.id, {
      name: 'reviewer',
      instructions: 'review',
      reasoning: { effort: 'high' },
      metadata: { a: '1', b: '2' },
    })
    expect(updated?.name).toBe('reviewer')
    expect(updated?.reasoning).toEqual({ effort: 'high' })
    expect(updated?.instructions).toBe('review')
    expect(store.update(agent.id, { metadata: { b: '3' } })?.metadata).toEqual({ b: '3' })
    expect(store.update(agent.id, { metadata: null, tools: null })?.metadata).toEqual({})
    expect(store.update(agent.id, { tools: [{ type: 'web_search' }] })?.tools).toEqual([{ type: 'web_search' }])
    expect(store.update(agent.id, { host_tools: { deny: ['web_search'] } })?.host_tools).toEqual({ deny: ['web_search'] })
    expect(store.update(agent.id, { host_tools: null })?.host_tools).toBeNull()
    expect(store.list({ limit: 20 }).data).toHaveLength(2)
    expect(store.delete(agent.id)).toBe(true)
    expect(store.get(agent.id)).toBeUndefined()
    expect(store.list({ limit: 20 }).data).toHaveLength(1)
    expect(store.update('missing', { name: 'x' })).toBeUndefined()
    expect(store.delete('missing')).toBe(false)
  })
})
