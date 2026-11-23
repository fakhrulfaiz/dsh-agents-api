import { describe, expect, it } from 'vitest'
import {
  AGENT_LIMIT,
  AgentInputError,
  createSavedAgent,
  toAgentParams,
  updateSavedAgent,
  validateAgentInput,
} from '../src/agent-service.ts'
import type { OwnerId } from '../src/auth/authenticator.ts'
import type { OAIAgent } from '../src/types.ts'

const owner = (id: string) => id as OwnerId
const visible = new Set(['read_file', 'grep', 'shell'])

/** Minimal in-memory `store.agents` keyed by owner. */
function fakeStore() {
  const rows = new Map<string, OAIAgent[]>()
  const agents = {
    async create(o: OwnerId, v: OAIAgent) {
      rows.set(o, [...(rows.get(o) ?? []), v])
      return v
    },
    async get(o: OwnerId, id: string) {
      return rows.get(o)?.find((a) => a.id === id)
    },
    async update(o: OwnerId, id: string, v: OAIAgent) {
      const list = rows.get(o) ?? []
      const i = list.findIndex((a) => a.id === id)
      if (i < 0) return undefined
      list[i] = v
      return v
    },
    async list(o: OwnerId, q: { limit: number }) {
      const data = (rows.get(o) ?? []).slice(0, q.limit)
      return { object: 'list' as const, data, first_id: null, last_id: null, has_more: false }
    },
    async delete() {
      return false
    },
  }
  return { store: { agents } as never, rows }
}

describe('validateAgentInput', () => {
  it('accepts a valid input', () => {
    expect(validateAgentInput({ name: 'Reviewer', toolsAllow: ['read_file'], apps: ['gmail', 'github'], subagents: 2 }, visible)).toBeUndefined()
  })
  it.each([
    [{ name: 'x'.repeat(81) }, /name/],
    [{ name: 'a', instructions: 'x'.repeat(20_001) }, /instructions/],
    [{ name: 'a', toolsAllow: ['nope'] }, /nope/],
    [{ name: 'a', toolsAllow: ['agent_create'] }, /agent_create/],
    [{ name: 'a', apps: ['Bad Slug'] }, /app/],
    [{ name: 'a', subagents: 99 }, /subagents/],
  ])('rejects %j', (input, message) => {
    expect(validateAgentInput(input, visible)).toMatch(message)
  })
})

describe('toAgentParams', () => {
  it('maps a new agent and denies the write tools', () => {
    const params = toAgentParams({ name: 'R', model: 'm', toolsAllow: ['read_file'], apps: ['gmail', 'github'], subagents: 3 })
    expect(params.host_tools).toEqual({ allow: ['read_file'], deny: ['agent_create', 'agent_update'] })
    expect(params.metadata).toEqual({})
    expect(params.apps).toEqual({ gmail: 'all', github: 'all' })
    expect(params.multi_agent).toEqual({ enabled: true, max_concurrent_subagents: 3 })
  })
  it('keeps what an update does not mention', () => {
    const existing = { id: 'agent_1', object: 'agent', created_at: 1, updated_at: 1, name: 'R', instructions: 'i', model: 'm', metadata: { connectors: 'gmail', note: 'x' }, tools: [], host_tools: { allow: ['grep'] } } as OAIAgent
    const params = toAgentParams({ name: 'R2', model: 'm' }, existing)
    expect(params.host_tools).toEqual({ allow: ['grep'], deny: ['agent_create', 'agent_update'] })
    expect(params.metadata).toEqual({ connectors: 'gmail', note: 'x' })
    expect(toAgentParams({ name: 'R', model: 'm', apps: [] }, existing).metadata).toEqual({ note: 'x' })
  })
})

describe('createSavedAgent / updateSavedAgent', () => {
  it('creates, scopes by owner and updates', async () => {
    const { store } = fakeStore()
    const created = await createSavedAgent(store, owner('a'), toAgentParams({ name: 'R', model: 'm' }))
    expect(created.id).toMatch(/^agent_/)
    expect(await updateSavedAgent(store, owner('b'), created.id, { name: 'X' })).toBeUndefined()
    expect((await updateSavedAgent(store, owner('a'), created.id, { name: 'X' }))?.name).toBe('X')
  })
  it('refuses the agent over the limit, per owner', async () => {
    const { store, rows } = fakeStore()
    rows.set('a', Array.from({ length: AGENT_LIMIT }, (_, i) => ({ id: `agent_${i}` }) as OAIAgent))
    await expect(createSavedAgent(store, owner('a'), toAgentParams({ name: 'R', model: 'm' }))).rejects.toThrow(AgentInputError)
    await expect(createSavedAgent(store, owner('b'), toAgentParams({ name: 'R', model: 'm' }))).resolves.toBeDefined()
  })
})
