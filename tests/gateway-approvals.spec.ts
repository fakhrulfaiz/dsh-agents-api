import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { ownerId } from '../src/auth/authenticator.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import type { OAISessionEvent } from '../src/types.ts'
import { bridgeHarness, question, type BridgeHarness } from './support/bridge-harness.ts'
import { FakeSessionQuery, logEvent, testGatewayOptions } from './support/fake-session-query.ts'
import { fakeLlm, fakeModel, type FakeModel } from './support/fake-model.ts'
import { MemoryStore } from './support/memory-store.ts'
import { openAuthenticator } from './open-auth.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

interface Fixture {
  root: string
  api: AgentsGateway
  store: MemoryStore
  registry: SessionRegistry
  h: BridgeHarness
  agents: Map<string, { cancel: ReturnType<typeof vi.fn>; followup: ReturnType<typeof vi.fn>; model: FakeModel }>
  created: Array<{ agentOptions: Record<string, unknown> }>
  llm: ReturnType<typeof fakeLlm>
  query: FakeSessionQuery
  /** Forget the live agent, as after a failed resume. */
  dropAgent: (id: string) => void
}

async function fixture(options: { models?: string[] } = {}): Promise<Fixture> {
  const agents: Fixture['agents'] = new Map()
  const created: Fixture['created'] = []
  const llm = fakeLlm()
  const ctx = {
    agents: {
      create: ({ sessionId, agentOptions }: { sessionId: string; agentOptions: Record<string, unknown> }) => {
        created.push({ agentOptions })
        const agent = { id: sessionId, followup: vi.fn(), steer: vi.fn(), cancel: vi.fn(), model: fakeModel() }
        agents.set(sessionId, agent)
        return Promise.resolve({ agent, dispose: vi.fn(() => Promise.resolve()) })
      },
      get: (id: string) => agents.get(id),
    },
    sessions: { get: (id: string) => agents.has(id) ? { id } : undefined },
    tools: { schemas: () => [] },
    llm,
    ...(options.models === undefined ? {} : {
      get: (name: string) => name === 'llm' ? { listProviders: () => [{ id: 'deepseek-official' }], listModels: () => Promise.resolve(options.models!.map(id => ({ id }))) } : undefined,
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as Context
  const h = bridgeHarness([])
  const query = new FakeSessionQuery()
  const store = new MemoryStore()
  const registry = new SessionRegistry()
  const api = new AgentsGateway(ctx, openAuthenticator, '/v1', store, registry, testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-approvals-spec')), query, h.bridge))
  h.onChange.mockImplementation((sessionId, actions) => { api.setInteractionActions(sessionId, actions) })
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    root: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`,
    api, store, registry, h, agents, created, llm, query,
    dropAgent: id => agents.delete(id),
  }
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', body: JSON.stringify(body) })
}

async function session(f: Fixture, agent: Record<string, unknown> = { model: 'deepseek-chat' }): Promise<string> {
  const response = await post(`${f.root}/agents/sessions`, { agent, environment: { type: 'none' } })
  expect(response.status).toBe(200)
  const id = ((await response.json()) as { id: string }).id
  f.h.claimed.add(id)
  return id
}

/** Start a turn and park one approval; returns the pending outcome and the wire id. */
function parkApproval(f: Fixture, id: string, extra: Partial<ApprovalRequestEvent> = {}, wireId = 'appr-1'): Promise<string> {
  f.api.applySessionEvent(id, logEvent('turn/start', { turn: 1 }, 1))
  f.h.log(id, 'approval/asked', { id: wireId, toolName: 'bash', callId: 'call_1' })
  return f.h.approve({ agent: f.h.agent(id), toolName: 'bash', callId: 'call_1' as never, reason: 'run it', ...extra })
}

const events = (f: Fixture, id: string, body: unknown): Promise<Response> => post(`${f.root}/agents/sessions/${id}/events`, body)
const read = async (f: Fixture, id: string) => (await (await fetch(`${f.root}/agents/sessions/${id}`)).json()) as { status: string; required_actions: Array<{ type: string; id?: string }>; agent: { model: string; reasoning?: { effort?: string } } }

describe('approvals over the API', () => {
  it('shows requires_action with the approval, writes the status, and fans an ephemeral frame out', async () => {
    const f = await fixture()
    const id = await session(f)
    const frames: Array<[OAISessionEvent, string | undefined]> = []
    f.registry.subscribe(id, (event, sseId) => { frames.push([event, sseId]) })
    void parkApproval(f, id)
    const view = await read(f, id)
    expect(view.status).toBe('requires_action')
    expect(view.required_actions).toEqual([expect.objectContaining({ type: 'approval', id: 'appr-1', kind: 'tool_approval', options: ['approve', 'deny'] })])
    await f.api.statusWritesSettled()
    expect((await f.store.sessions.get(id, 'any'))?.status).toBe('requires_action')
    const frame = frames.find(([event]) => event.type === 'agent.session.requires_action')
    expect(frame?.[1]).toBeUndefined()
  })

  it('shows a subagent approval on the parent through the parent turn end, and the parent answers it', async () => {
    const f = await fixture()
    const id = await session(f)
    f.api.applySessionEvent(id, logEvent('turn/start', { turn: 1 }, 1))
    f.h.log('child_1', 'approval/asked', { id: 'appr-c', toolName: 'bash', callId: 'call_9' })
    const outcome = f.h.approve({ agent: f.h.child('child_1', id), toolName: 'bash', callId: 'call_9' as never, reason: 'run it' })
    expect((await read(f, id)).required_actions).toEqual([expect.objectContaining({ id: 'appr-c', subagent_id: 'child_1' })])
    // The parent's turn ends while the child keeps waiting.
    f.h.log(id, 'turn/end', {})
    f.api.applySessionEvent(id, logEvent('turn/end', { reason: { kind: 'completed' } }, 2))
    expect(await read(f, id)).toMatchObject({ status: 'requires_action', required_actions: [{ id: 'appr-c', subagent_id: 'child_1' }] })
    expect((await events(f, id, { type: 'agent.session.input.approval_response', id: 'appr-c', decision: 'approve' })).status).toBe(200)
    await expect(outcome).resolves.toBe('allowed-once')
    expect(await read(f, id)).toMatchObject({ status: 'idle', required_actions: [] })
  })

  it('approve resolves the request and the session goes back to in_progress', async () => {
    const f = await fixture()
    const id = await session(f)
    const outcome = parkApproval(f, id)
    const response = await events(f, id, { type: 'agent.session.input.approval_response', id: 'appr-1', decision: 'approve' })
    expect(response.status).toBe(200)
    await expect(outcome).resolves.toBe('allowed-once')
    expect((await read(f, id)).status).toBe('in_progress')
    await f.api.statusWritesSettled()
    expect((await f.store.sessions.get(id, 'any'))?.status).toBe('in_progress')
  })

  it('answers a user question with a batch', async () => {
    const f = await fixture()
    const id = await session(f)
    f.api.applySessionEvent(id, logEvent('turn/start', { turn: 1 }, 1))
    const answer = f.h.ask({ agent: f.h.agent(id), questions: [question('q1')] })
    const wireId = (await read(f, id)).required_actions[0]!.id
    expect((await events(f, id, { events: [{ type: 'agent.session.input.approval_response', id: wireId, decision: 'answer', payload: { selected: ['B'] } }] })).status).toBe(200)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['B'] }] })
  })

  it('approval after cancel is not found', async () => {
    const f = await fixture()
    const id = await session(f)
    const outcome = parkApproval(f, id)
    expect((await events(f, id, { type: 'agent.session.input.cancel' })).status).toBe(200)
    await expect(outcome).resolves.toBe('cancelled')
    expect(f.agents.get(id)?.cancel).toHaveBeenCalled()
    const late = await events(f, id, { type: 'agent.session.input.approval_response', id: 'appr-1', decision: 'approve' })
    expect(late.status).toBe(404)
    expect(await late.json()).toMatchObject({ error: { code: 'approval_not_found' } })
  })

  it('returns to idle with no required actions after a cancelled approval ends its turn', async () => {
    const f = await fixture()
    const id = await session(f)
    void parkApproval(f, id)
    await events(f, id, { type: 'agent.session.input.cancel' })
    f.api.applySessionEvent(id, logEvent('turn/end', { reason: { kind: 'aborted' } }, 2))
    expect(await read(f, id)).toMatchObject({ status: 'idle', required_actions: [] })
    await f.api.statusWritesSettled()
    expect((await f.store.sessions.get(id, 'any'))?.status).toBe('idle')
  })

  it('cancels pending requests when the session is deleted', async () => {
    const f = await fixture()
    const id = await session(f)
    const outcome = parkApproval(f, id)
    expect((await fetch(`${f.root}/agents/sessions/${id}`, { method: 'DELETE' })).status).toBe(200)
    await expect(outcome).resolves.toBe('cancelled')
    expect(f.h.bridge.pending(id)).toEqual([])
  })

  it('answers 404 for a second answer, an unknown id, and another owner', async () => {
    const f = await fixture()
    const id = await session(f)
    void parkApproval(f, id)
    const respond = (approval: string) => events(f, id, { type: 'agent.session.input.approval_response', id: approval, decision: 'approve' })
    expect((await respond('nope')).status).toBe(404)
    expect((await respond('appr-1')).status).toBe(200)
    expect((await respond('appr-1')).status).toBe(404)

    await f.store.ensureOwner(ownerId('other'))
    const row = (await f.store.sessions.get(id, 'any'))!
    await f.store.sessions.insert({ ...row, id: 'sess_theirs', ownerId: ownerId('other'), dshSessionId: 'sess_theirs' })
    const foreign = await events(f, 'sess_theirs', { type: 'agent.session.input.approval_response', id: 'appr-1', decision: 'approve' })
    expect(foreign.status).toBe(404)
  })

  it('answers 400 for malformed responses and mismatched decisions', async () => {
    const f = await fixture()
    const id = await session(f)
    void parkApproval(f, id)
    const bad = await events(f, id, { type: 'agent.session.input.approval_response', id: 'appr-1', decision: 'maybe' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_approval_response' } })
    const wrong = await events(f, id, { type: 'agent.session.input.approval_response', id: 'appr-1', decision: 'answer', payload: {} })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ error: { code: 'decision_not_applicable' } })
  })
})

/** Read the SSE stream until `done(text)` or `quietMs` passes without a chunk. */
async function sseText(response: Response, quietMs = 300): Promise<string> {
  const reader = response.body!.getReader()
  let text = ''
  for (;;) {
    const chunk = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => { resolve(null) }, quietMs))])
    if (chunk === null || chunk.done) break
    text += new TextDecoder().decode(chunk.value)
  }
  await reader.cancel()
  return text
}

describe('reconnecting streams', () => {
  const connect = (f: Fixture, id: string) => fetch(`${f.root}/agents/sessions/${id}/events`, { headers: { 'last-event-id': '1' } })

  it('sends a snapshot with the pending approval after the replayed frames, without an id', async () => {
    const f = await fixture()
    const id = await session(f)
    f.query.append(id, logEvent('turn/start', { turn: 1 }, 1))
    void parkApproval(f, id)
    const text = await sseText(await connect(f, id))
    const frames = text.split('\n\n').filter(Boolean)
    const last = frames.at(-1)!
    expect(last).not.toMatch(/^id:/mu)
    expect(last).toContain('event: agent.session.requires_action')
    expect(last).toContain('"id":"appr-1"')
    expect(frames.slice(0, -1).every(frame => /^id: \d+/u.test(frame))).toBe(true)
    expect(frames.length).toBeGreaterThan(1)
  })

  it('sends no extra snapshot when nothing is pending', async () => {
    const f = await fixture()
    const id = await session(f)
    f.query.append(id, logEvent('turn/start', { turn: 1 }, 1))
    f.api.applySessionEvent(id, logEvent('turn/start', { turn: 1 }, 1))
    const text = await sseText(await connect(f, id))
    expect(text).not.toContain('requires_action')
    expect(text.split('\n\n').filter(Boolean).every(frame => /^id: \d+/u.test(frame))).toBe(true)
  })
})

describe('approval answers for a session that is not live', () => {
  it('answers 404 approval_not_found without resuming', async () => {
    const f = await fixture()
    const id = await session(f)
    f.registry.delete(id)
    const readsBefore = f.query.reads
    const response = await events(f, id, { type: 'agent.session.input.approval_response', id: 'x', decision: 'approve' })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'approval_not_found' } })
    expect(f.query.reads).toBe(readsBefore)
  })
})

describe('live model and effort', () => {
  it('applies a model and effort update to the live agent', async () => {
    const f = await fixture()
    const id = await session(f)
    const response = await post(`${f.root}/agents/sessions/${id}`, { agent: { model: 'deepseek-reasoner', reasoning: { effort: 'high' } } })
    expect(response.status).toBe(200)
    expect(f.llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' })
    expect(f.agents.get(id)?.model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' })
    expect(f.llm.resolveCallConfig.mock.invocationCallOrder[0]!).toBeLessThan(f.agents.get(id)!.model.select.mock.invocationCallOrder[0]!)
    expect(await read(f, id)).toMatchObject({ agent: { model: 'deepseek-reasoner', reasoning: { effort: 'high' } } })
    expect((await f.store.sessions.get(id, 'any'))).toMatchObject({ model: 'deepseek-reasoner', reasoningEffort: 'high' })
  })

  it('re-sends the current model for an effort-only update', async () => {
    const f = await fixture()
    const id = await session(f)
    await post(`${f.root}/agents/sessions/${id}`, { agent: { reasoning: { effort: 'low' } } })
    expect(f.agents.get(id)?.model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'low' })
  })

  it('does not touch the agent for metadata or an unchanged model', async () => {
    const f = await fixture()
    const id = await session(f)
    f.dropAgent(id)
    const response = await post(`${f.root}/agents/sessions/${id}`, { metadata: { k: 'v' }, agent: { model: 'deepseek-chat', service_tier: 'flex' } })
    expect(response.status).toBe(200)
    expect(f.llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('answers 409 and stores nothing when the route is unsupported', async () => {
    const f = await fixture()
    const id = await session(f)
    f.llm.resolveCallConfig.mockRejectedValueOnce(new Error('effort "max" is not supported by deepseek-chat'))
    const update = vi.spyOn(f.store.sessions, 'update')
    const response = await post(`${f.root}/agents/sessions/${id}`, { agent: { reasoning: { effort: 'max' } } })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'session_setting_not_live', message: expect.stringContaining('not supported') } })
    expect(f.agents.get(id)?.model.select).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect((await read(f, id)).agent.model).toBe('deepseek-chat')
  })

  it('answers 409 when select throws or the session has no live agent', async () => {
    const f = await fixture()
    const id = await session(f)
    f.agents.get(id)!.model.select.mockImplementationOnce(() => { throw new Error('session closed') })
    const failed = await post(`${f.root}/agents/sessions/${id}`, { agent: { model: 'deepseek-reasoner' } })
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ error: { code: 'session_setting_not_live', message: 'session closed' } })

    f.dropAgent(id)
    f.registry.delete(id)
    const orphan = await post(`${f.root}/agents/sessions/${id}`, { agent: { model: 'deepseek-reasoner' } })
    expect(orphan.status).toBe(409)
    expect(await orphan.json()).toMatchObject({ error: { code: 'session_setting_not_live' } })
    expect((await f.store.sessions.get(id, 'any'))?.model).toBe('deepseek-chat')
  })

  it('switches model and effort from a follow-up message before queueing it', async () => {
    const f = await fixture()
    const id = await session(f)
    const response = await events(f, id, {
      type: 'agent.session.input.message',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'think harder' }] }],
      model: 'deepseek-reasoner',
      reasoning: { effort: 'high' },
    })
    expect(response.status).toBe(200)
    const agent = f.agents.get(id)!
    expect(agent.model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' })
    expect(agent.model.select.mock.invocationCallOrder[0]!).toBeLessThan(agent.followup.mock.invocationCallOrder[0]!)
    expect((await read(f, id)).agent.model).toBe('deepseek-reasoner')
  })

  it('rejects a follow-up with an unsupported model and sends no message', async () => {
    const f = await fixture()
    const id = await session(f)
    f.llm.resolveCallConfig.mockRejectedValueOnce(new Error('unknown model'))
    const response = await events(f, id, { type: 'agent.session.input.message', input: 'hi', model: 'nope' })
    expect(response.status).toBe(409)
    expect(f.agents.get(id)?.followup).not.toHaveBeenCalled()
  })
})

describe('models that are not offered', () => {
  it('answers 409 session_setting_not_live for an unknown follow-up model and sends nothing', async () => {
    const f = await fixture({ models: ['deepseek-chat', 'deepseek-reasoner'] })
    const id = await session(f)
    const response = await events(f, id, { type: 'agent.session.input.message', input: 'hi', model: 'nope' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'session_setting_not_live', message: expect.stringContaining('nope') } })
    expect(f.agents.get(id)?.followup).not.toHaveBeenCalled()
    expect(f.agents.get(id)?.model.select).not.toHaveBeenCalled()
    expect((await read(f, id)).agent.model).toBe('deepseek-chat')
  })

  it('answers 409 for an unknown model on a session update and stores nothing', async () => {
    const f = await fixture({ models: ['deepseek-chat'] })
    const id = await session(f)
    const update = vi.spyOn(f.store.sessions, 'update')
    const response = await post(`${f.root}/agents/sessions/${id}`, { agent: { model: 'nope' } })
    expect(response.status).toBe(409)
    expect(update).not.toHaveBeenCalled()
  })

  it('accepts a listed model, and an effort-only update whose stored model is no longer listed', async () => {
    const f = await fixture({ models: ['deepseek-reasoner'] })
    const id = await session(f)
    expect((await post(`${f.root}/agents/sessions/${id}`, { agent: { model: 'deepseek-reasoner' } })).status).toBe(200)
    const g = await fixture({ models: ['other'] })
    const gid = await session(g)
    expect((await post(`${g.root}/agents/sessions/${gid}`, { agent: { reasoning: { effort: 'low' } } })).status).toBe(200)
  })
})

describe('clearing the reasoning effort', () => {
  it('clears a stored effort on a session update and re-selects without one', async () => {
    const f = await fixture()
    const id = await session(f, { model: 'deepseek-chat', reasoning: { effort: 'high' } })
    const response = await post(`${f.root}/agents/sessions/${id}`, { agent: { reasoning: { effort: null } } })
    expect(response.status).toBe(200)
    expect(f.agents.get(id)?.model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect((await read(f, id)).agent.reasoning?.effort).toBeUndefined()
    expect((await f.store.sessions.get(id, 'any'))?.reasoningEffort).toBeNull()
  })

  it('clears the effort from a follow-up message', async () => {
    const f = await fixture()
    const id = await session(f, { model: 'deepseek-chat', reasoning: { effort: 'high' } })
    const response = await events(f, id, { type: 'agent.session.input.message', input: 'hi', reasoning: { effort: null } })
    expect(response.status).toBe(200)
    expect(f.agents.get(id)?.model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect((await f.store.sessions.get(id, 'any'))?.reasoningEffort).toBeNull()
  })
})

describe('session metadata merge and filter', () => {
  const meta = async (f: Fixture, id: string) => ((await (await fetch(`${f.root}/agents/sessions/${id}`)).json()) as { metadata: Record<string, string> }).metadata

  it('metadata_merge sets and deletes single keys and keeps the others', async () => {
    const f = await fixture()
    const id = await session(f, { model: 'deepseek-chat' })
    await post(`${f.root}/agents/sessions/${id}`, { metadata: { title: 'A', starred: 'true' } })
    const response = await post(`${f.root}/agents/sessions/${id}`, { metadata_merge: { starred: null, color: 'red' } })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { metadata: unknown }).metadata).toEqual({ title: 'A', color: 'red' })
    expect(await meta(f, id)).toEqual({ title: 'A', color: 'red' })
    expect((await f.store.sessions.get(id, 'any'))?.body?.metadata).toEqual({ title: 'A', color: 'red' })
  })

  it('concurrent merges of different keys both survive, and plain metadata still replaces', async () => {
    const f = await fixture()
    const id = await session(f)
    await Promise.all([
      post(`${f.root}/agents/sessions/${id}`, { metadata_merge: { a: '1' } }),
      post(`${f.root}/agents/sessions/${id}`, { metadata_merge: { b: '2' } }),
    ])
    expect(await meta(f, id)).toEqual({ a: '1', b: '2' })
    await post(`${f.root}/agents/sessions/${id}`, { metadata: { c: '3' } })
    expect(await meta(f, id)).toEqual({ c: '3' })
  })

  it('rejects a metadata_merge value that is not a string or null', async () => {
    const f = await fixture()
    const id = await session(f)
    expect((await post(`${f.root}/agents/sessions/${id}`, { metadata_merge: { a: 1 } })).status).toBe(400)
  })

  it('lists sessions filtered by metadata[key]=value across pages', async () => {
    const f = await fixture()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(await session(f))
    await post(`${f.root}/agents/sessions/${ids[0]}`, { metadata_merge: { starred: 'true' } })
    await post(`${f.root}/agents/sessions/${ids[3]}`, { metadata_merge: { starred: 'true', x: 'y' } })
    const list = async (query: string) => ((await (await fetch(`${f.root}/agents/sessions?${query}`)).json()) as { data: Array<{ id: string }>; has_more: boolean })
    expect((await list('metadata[starred]=true')).data.map(row => row.id).sort()).toEqual([ids[0]!, ids[3]!].sort())
    expect((await list('metadata[starred]=true&metadata[x]=y')).data.map(row => row.id)).toEqual([ids[3]])
    expect((await list('metadata[starred]=true&limit=1')).has_more).toBe(true)
    expect((await list('metadata[starred]=false')).data).toEqual([])
  })
})

describe('session creation effort', () => {
  it('passes the wire reasoning effort to DSH', async () => {
    const f = await fixture()
    await session(f, { model: 'deepseek-chat', reasoning: { effort: 'high' } })
    expect(f.created[0]?.agentOptions).toMatchObject({ model: 'deepseek-chat', reasoningEffort: 'high' })
  })

  it('answers 400 for an effort the model does not support', async () => {
    const f = await fixture()
    f.llm.resolveCallConfig.mockRejectedValueOnce(new Error('effort "max" is not supported'))
    const response = await post(`${f.root}/agents/sessions`, { agent: { model: 'deepseek-chat', reasoning: { effort: 'max' } }, environment: { type: 'none' } })
    expect(response.status).toBe(400)
    expect(f.created).toEqual([])
  })
})
