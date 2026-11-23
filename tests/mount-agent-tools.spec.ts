import { describe, expect, it } from 'vitest'
import { mountAgentTools } from '../src/mount-agent-tools.ts'
import type { OwnerId } from '../src/auth/authenticator.ts'
import type { OAIAgent } from '../src/types.ts'

const owner = (o: string) => o as OwnerId
const LIB = `skill_${'b'.repeat(32)}`

function harness(names: string[], who = 'a', extra: Record<string, unknown> = {}) {
  const rows = new Map<string, OAIAgent[]>()
  const store = {
    agents: {
      async create(o: OwnerId, v: OAIAgent) { rows.set(o, [...(rows.get(o) ?? []), v]); return v },
      async get(o: OwnerId, id: string) { return rows.get(o)?.find((a) => a.id === id) },
      async update(o: OwnerId, id: string, v: OAIAgent) {
        const l = rows.get(o) ?? []; const i = l.findIndex((a) => a.id === id)
        if (i < 0) return undefined
        l[i] = v; return v
      },
      async list(o: OwnerId, q: { limit: number }) { return { object: 'list', data: (rows.get(o) ?? []).slice(0, q.limit), first_id: null, last_id: null, has_more: false } },
    },
    skills: {
      async get(id: string, o: OwnerId) { return id === LIB && o === 'a' ? { id: LIB, owner: o, scope: 'library', status: 'active' } : undefined },
    },
  }
  const registered = new Map<string, { execute(args: unknown): Promise<unknown> }>()
  let handler: ((exec: { name: string; arguments: unknown }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    tools: {
      register(def: { name: string; execute(a: unknown): Promise<unknown> }) { registered.set(def.name, def); return () => undefined },
      schemas: () => [...names, ...registered.keys()].map((name) => ({ name, description: `the ${name} tool` })),
    },
    on(_event: string, fn: typeof handler) { handler = fn; return () => undefined },
  }
  mountAgentTools(ctx as never, { owner: owner(who), store: store as never, defaultModel: 'm1', builtinSkills: () => new Set(['create-agent', 'composio']), ...extra })
  const call = async (name: string, args: unknown) => JSON.parse((await registered.get(name)!.execute(args)) as string)
  return { call, registered, rows, ask: (name: string, args: unknown) => handler!({ name, arguments: args }, async () => ({ kind: 'allow' })) }
}

describe('agent tools: apps and skills', () => {
  it('apps become grants clamped to the calling agent', async () => {
    const { call, rows } = harness(['read_file'], 'a', { callerGrants: { gmail: ['GMAIL_FETCH_EMAILS'] } })
    expect(await call('agent_create', { name: 'Mail', apps: ['gmail', 'slack'] })).toMatchObject({ name: 'Mail' })
    expect(rows.get('a')![0]!.apps).toEqual({ gmail: ['GMAIL_FETCH_EMAILS'] })
  })
  it('an unrestricted caller passes apps through; get reports grants', async () => {
    const { call } = harness(['read_file'])
    const { id } = await call('agent_create', { name: 'Mail', apps: ['gmail'] }) as { id: string }
    expect((await call('agent_get', { id })).apps).toEqual({ gmail: 'all' })
  })
  it('validates a skills selection against built-ins and the owner library', async () => {
    const { call, rows } = harness(['read_file'])
    expect((await call('agent_create', { name: 'S', skills: { builtin: ['nope'], library: [] } })).error).toMatch(/nope/)
    expect((await call('agent_create', { name: 'S', skills: { builtin: [], library: [`skill_${'c'.repeat(32)}`] } })).error).toMatch(/library/)
    expect(await call('agent_create', { name: 'S', skills: { builtin: ['composio'], library: [LIB] } })).toMatchObject({ name: 'S' })
    expect(rows.get('a')![0]!.skills).toEqual({ builtin: ['composio'], library: [LIB] })
  })
})

describe('agent tools with a Host catalog', () => {
  it('lists the catalog from listTools, not the agent scope registry, and checks tools_allow against it', async () => {
    const rows = new Map<string, OAIAgent[]>()
    const store = {
      agents: {
        async create(o: OwnerId, v: OAIAgent) { rows.set(o, [...(rows.get(o) ?? []), v]); return v },
        async list() { return { object: 'list', data: [], first_id: null, last_id: null, has_more: false } },
        async get() { return undefined },
      },
    }
    const seenAgents: unknown[] = []
    const registered = new Map<string, { execute(args: unknown, exec?: unknown): Promise<unknown> }>()
    // The scope registry sees only global tools; the model-facing ones live on the default preset.
    const ctx = {
      tools: { register(def: { name: string; execute(a: unknown): Promise<unknown> }) { registered.set(def.name, def); return () => undefined }, schemas: () => [{ name: 'working_directory' }] },
      on: () => () => undefined,
    }
    mountAgentTools(ctx as never, {
      owner: owner('a'),
      store: store as never,
      defaultModel: 'm1',
      listTools: async (agent) => {
        seenAgents.push(agent)
        return [{ name: 'read_file', description: 'Read a file' }, { name: 'shell' }, { name: 'agent_create' }, { name: 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS' }]
      },
    })
    const run = async (name: string, args: unknown) => JSON.parse((await registered.get(name)!.execute(args)) as string)
    const out = JSON.parse((await registered.get('agent_tools')!.execute({}, { agent: 'the-agent' })) as string)
    expect(seenAgents).toEqual(['the-agent'])
    expect(out.tools.map((t: { name: string }) => t.name)).toEqual(['read_file', 'shell', 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS'])
    expect(out.mcp_servers).toEqual([{ server: 'composio', tool_count: 1, sample: ['COMPOSIO_MANAGE_CONNECTIONS'] }])
    expect((await run('agent_create', { name: 'R', tools_allow: ['shell'] })).name).toBe('R')
    expect((await run('agent_create', { name: 'R', tools_allow: ['working_directory'] })).error).toMatch(/working_directory/)
  })
})

describe('agent tools', () => {
  it('registers the five tools', () => {
    expect([...harness([]).registered.keys()].sort()).toEqual(['agent_create', 'agent_get', 'agent_list', 'agent_tools', 'agent_update'])
  })
  it('agent_tools lists tools without agent_* and groups MCP servers', async () => {
    const { call } = harness(['read_file', 'mcp__composio__COMPOSIO_SEARCH_TOOLS', 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS', 'mcp__other__lookup'])
    const out = await call('agent_tools', {})
    expect(out.tools.map((t: { name: string }) => t.name)).toEqual(['read_file', 'mcp__composio__COMPOSIO_SEARCH_TOOLS', 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS', 'mcp__other__lookup'])
    expect(out.mcp_servers).toEqual([
      { server: 'composio', tool_count: 2, sample: ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_MANAGE_CONNECTIONS'] },
      { server: 'other', tool_count: 1, sample: ['lookup'] },
    ])
    expect((await harness(['read_file']).call('agent_tools', {})).mcp_servers).toEqual([])
  })
  it('creates with visible tools only and refuses unseen or agent_* names', async () => {
    const { call, rows } = harness(['read_file', 'grep'])
    expect((await call('agent_create', { name: 'R', toolsAllow: undefined, tools_allow: ['shell'] })).error).toMatch(/shell/)
    expect((await call('agent_create', { name: 'R', tools_allow: ['agent_create'] })).error).toMatch(/agent_create/)
    expect(rows.size).toBe(0)
    const ok = await call('agent_create', { name: 'R', instructions: 'Review.', tools_allow: ['read_file'], apps: ['gmail'] })
    expect(ok).toMatchObject({ name: 'R' })
    const saved = rows.get('a')![0]!
    expect(saved.model).toBe('m1')
    expect(saved.host_tools).toEqual({ allow: ['read_file'], deny: ['agent_create', 'agent_update'] })
    expect(saved.metadata).toEqual({})
    expect(saved.apps).toEqual({ gmail: 'all' })
  })
  it('scopes by owner and clamps list', async () => {
    const h = harness(['read_file'])
    const { id } = await h.call('agent_create', { name: 'R' })
    h.rows.set('b', [])
    expect((await h.call('agent_get', { id })).name).toBe('R')
    expect((await h.call('agent_update', { id: 'agent_other', name: 'X' })).error).toMatch(/no agent/)
    expect((await h.call('agent_list', { limit: 5000 })).agents).toHaveLength(1)
  })
  it('asks before writes and allows reads', async () => {
    const { ask } = harness([])
    expect(await ask('agent_create', { name: 'R', instructions: 'a   b' })).toMatchObject({ kind: 'ask', reason: 'Create agent "R": a b' })
    expect(await ask('agent_update', { id: 'agent_1' })).toMatchObject({ kind: 'ask' })
    expect(await ask('agent_list', {})).toEqual({ kind: 'allow' })
  })
})
