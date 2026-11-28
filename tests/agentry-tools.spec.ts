import { describe, expect, it } from 'vitest'
import { ownerId, type OwnerId } from '../src/auth/authenticator.ts'
import type { BuiltinLibraryItem } from '../src/agent-import/builtin-library.ts'
import type { EnvironmentRecord } from '../src/environment-types.ts'
import { mountAgentryTools, type AgentryToolsDeps } from '../src/mount-agentry-tools.ts'
import type { LibrarySource } from '../src/store/store.ts'
import { MemoryStore } from './support/memory-store.ts'

const alice = ownerId('alice')
const bob = ownerId('bob')

const planner: BuiltinLibraryItem = {
  ref: 'Agentry:planner.md', source: 'Agentry', name: 'Planner', slug: 'planner', description: 'Plans the work', text: '',
  draft: { name: 'Planner', instructions: 'Plan it.', metadata: { description: 'Plans the work' }, host_tools: { allow: ['read'] } },
}
const bobSource: LibrarySource = { id: 'lsrc_b', object: 'library.source', label: 'Mine', url: 'https://github.com/b/r/tree/main/agents', created_at: 1 }

const env = (id: string, name: string): EnvironmentRecord => ({ id, object: 'environment', status: 'ready', provider: 'sandbox', provider_metadata: { name }, created_at: 1 } as unknown as EnvironmentRecord)

function harness(store: MemoryStore, owner: OwnerId, extra: Partial<AgentryToolsDeps> = {}) {
  const registered = new Map<string, { execute(args: unknown): Promise<unknown> }>()
  let handler: ((exec: { name: string; arguments: unknown }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    tools: { register(def: { name: string; execute(a: unknown): Promise<unknown> }) { registered.set(def.name, def); return () => undefined } },
    on(_event: string, fn: typeof handler) { handler = fn; return () => undefined },
  }
  const deps: AgentryToolsDeps = {
    owner,
    store,
    sessionId: 'sess_1',
    defaultModel: 'm1',
    builtinAgentIds: new Set(['agentry']),
    library: {
      builtin: async () => [planner],
      // Only bob has a source.
      sources: async (who) => who === bob ? [{ source: bobSource, candidates: [{ name: 'writer', description: 'Writes', url: 'https://github.com/b/r/blob/main/agents/writer.md' }] }] : [],
      draft: async () => ({ name: 'Writer', instructions: 'Write.' }),
    },
    describe: async (record) => ({ id: record.id, name: record.provider_metadata['name'], provider: record.provider, status: record.status } as never),
    moveChat: async () => true,
    ...extra,
  }
  mountAgentryTools(ctx as never, deps)
  const call = async (name: string, args: unknown) => JSON.parse((await registered.get(name)!.execute(args)) as string) as Record<string, unknown>
  return { call, ask: (name: string, args: unknown) => handler!({ name, arguments: args }, async () => ({ kind: 'allow' })) }
}

async function setup() {
  const store = new MemoryStore()
  await store.ensureOwner(alice)
  await store.ensureOwner(bob)
  await store.environments.create(alice, env('env_a', 'Test sandbox'))
  await store.environments.create(bob, env('env_b', 'Bob box'))
  return { store, a: harness(store, alice), b: harness(store, bob) }
}

describe('agentry tools: projects', () => {
  it('create, list and update only the owner\'s projects, with the owner\'s environments and agents', async () => {
    const { a, b } = await setup()
    expect((await a.call('project_create', { name: 'Recipes', environment_id: 'env_b' })).error).toMatch(/no environment "env_b"/)
    expect((await a.call('project_create', { name: 'Recipes', agent_id: 'agent_nope' })).error).toMatch(/no agent/)
    const made = await a.call('project_create', { name: 'Recipes', environment_id: 'env_a', directory: 'recipe-site', agent_id: 'agentry' })
    expect(made).toMatchObject({ name: 'Recipes', environment_id: 'env_a', directory: 'recipe-site', agent_id: 'agentry', link: `/?project=${String(made.id)}` })
    expect((await b.call('project_list', {})).projects).toEqual([])
    expect((await b.call('project_update', { id: made.id, name: 'Mine' })).error).toMatch(/no project/)
    expect((await b.call('chat_move_to_project', { project_id: made.id })).error).toMatch(/no project/)
    expect(await a.call('project_update', { id: made.id, directory: 'recipes' })).toMatchObject({ environment_id: 'env_a', directory: 'recipes' })
    expect((await a.call('project_list', {})).projects).toHaveLength(1)
  })
})

describe('agentry tools: environments', () => {
  it('lists only the owner\'s environments', async () => {
    const { a } = await setup()
    expect((await a.call('environment_list', {})).environments).toEqual([expect.objectContaining({ id: 'env_a', name: 'Test sandbox', link: '/sandboxes/env_a' })])
  })
})

describe('agentry tools: Library', () => {
  it('searches built-ins plus only the owner\'s sources, and names a colliding agent "Name (Source)"', async () => {
    const { store, a, b } = await setup()
    expect(((await a.call('library_search', {})).agents as unknown[]).map((i) => (i as { ref: string }).ref)).toEqual(['Agentry:planner.md'])
    expect(((await b.call('library_search', { query: 'writ' })).agents as unknown[])).toEqual([expect.objectContaining({ name: 'Writer', source: 'Mine' })])
    expect((await a.call('library_add', { ref: 'Mine:https://github.com/b/r/blob/main/agents/writer.md' })).error).toMatch(/no Library entry/)
    expect(await a.call('library_add', { ref: 'Agentry:planner.md' })).toMatchObject({ name: 'Planner' })
    expect(await a.call('library_add', { ref: 'Agentry:planner.md' })).toMatchObject({ name: 'Planner (Agentry)' })
    expect(await a.call('library_add', { ref: 'Agentry:planner.md' })).toMatchObject({ name: 'Planner (Agentry) 2' })
    const saved = (await store.agents.list(alice, { limit: 10 })).data[0]!
    expect(saved).toMatchObject({ model: 'm1', instructions: 'Plan it.', metadata: { library_source: 'Agentry', library_ref: 'Agentry:planner.md' } })
    expect(await b.call('library_add', { ref: 'Mine:https://github.com/b/r/blob/main/agents/writer.md' })).toMatchObject({ name: 'Writer' })
    expect((await store.agents.list(bob, { limit: 10 })).data).toHaveLength(1)
  })
})

describe('agentry tools: approval', () => {
  it('asks before every create or change and never for reads', async () => {
    const { a } = await setup()
    expect(await a.ask('project_create', { name: 'Recipes', environment_id: 'env_a', directory: 'recipe-site' })).toMatchObject({ kind: 'ask', reason: 'Create project "Recipes": environment "Test sandbox", folder recipe-site' })
    for (const name of ['project_update', 'chat_move_to_project', 'library_add']) expect(await a.ask(name, { id: 'proj_x', project_id: 'proj_x', ref: 'Agentry:planner.md' })).toMatchObject({ kind: 'ask' })
    for (const name of ['project_list', 'library_search', 'environment_list', 'schedule_create']) expect(await a.ask(name, {})).toEqual({ kind: 'allow' })
    // The built-in assistant also asks before schedule writes.
    const assistant = harness(new MemoryStore(), alice, { askSchedules: true })
    expect(await assistant.ask('schedule_create', { title: 'Plan meals', rrule: 'DTSTART:20261130T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO', prompt: 'Remind me.' })).toMatchObject({ kind: 'ask', reason: 'Create schedule "Plan meals" (FREQ=WEEKLY;BYDAY=MO): Remind me.' })
  })
})
