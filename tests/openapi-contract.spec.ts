/**
 * Responses the gateway produces must validate against the schemas in
 * `openapi/agentry.yaml`, so generated client types match the wire.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createStaticKeyAuthenticator } from '../src/auth/static-key.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { openAuthenticator } from './open-auth.ts'
import { fakeLlm, fakeModel } from './support/fake-model.ts'
import { FakeSchedule } from './support/fake-schedule.ts'
import { FakeSessionQuery, logEvent, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'
import { SpecValidator } from './support/openapi.ts'
import type { Authenticator } from '../src/auth/authenticator.ts'

const spec = new SpecValidator()
const servers: Server[] = []
const environments = createLocalProvider(join(tmpdir(), 'agentry-openapi-contract'))

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })))
})

function fakeContext(): Context {
  const agents = new Map<string, unknown>()
  return {
    agents: {
      create: ({ sessionId }: { sessionId: string }) => {
        const agent = { followup: vi.fn(), steer: vi.fn(), cancel: vi.fn(), model: fakeModel() }
        agents.set(sessionId, agent)
        return Promise.resolve({ agent, dispose: vi.fn(() => Promise.resolve()) })
      },
      get: (id: string) => agents.get(id),
    },
    sessions: { get: (id: string) => agents.has(id) ? { id } : undefined },
    llm: fakeLlm(),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    tools: { schemas: () => [{ name: 'web_fetch', description: 'Fetch a URL', parameters: { type: 'object', properties: {} } }] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  } as unknown as Context
}

async function start(authenticator: Authenticator = openAuthenticator, store = new MemoryStore(), schedule?: FakeSchedule) {
  const query = new FakeSessionQuery()
  const api = new AgentsGateway(fakeContext(), authenticator, '/v1', store, new SessionRegistry(), { ...testGatewayOptions(environments, query), schedule: () => schedule?.asService() })
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  /**
   * Send a request, then validate the request body and the JSON response against the spec.
   * @param method - HTTP method.
   * @param template - spec path, for example `/v1/agents/{agent_id}`.
   * @param params - path parameter values.
   * @param body - JSON request body.
   * @param expected - expected status.
   * @returns the parsed response body.
   */
  async function call(method: string, template: string, params: Record<string, string>, body: unknown, expected: number): Promise<any> {
    const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? '')
    if (body !== undefined && expected < 400) expect(spec.request(method, template, body), `${method} ${template} request`).toEqual([])
    const res = await fetch(origin + path, {
      method,
      headers: { 'openai-beta': 'agents=v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    expect(res.status).toBe(expected)
    const parsed = await res.json() as unknown
    expect(spec.response(method, template, res.status, parsed), `${method} ${template} -> ${String(res.status)}`).toEqual([])
    return parsed
  }
  return { api, query, origin, call }
}

describe('OpenAPI responses', () => {
  it('validates saved agents, tools, and errors', async () => {
    const { call } = await start()
    const agent = await call('POST', '/v1/agents', {}, {
      model: 'deepseek-chat',
      name: 'Helper',
      instructions: 'Be brief',
      metadata: { team: 'a' },
      tools: [{ type: 'function', name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
      reasoning: { effort: 'high' },
      host_tools: { deny: ['web_fetch'] },
    }, 200)
    await call('GET', '/v1/agents', {}, undefined, 200)
    await call('GET', '/v1/agents/{agent_id}', { agent_id: agent.id }, undefined, 200)
    await call('POST', '/v1/agents/{agent_id}', { agent_id: agent.id }, { name: 'Renamed', service_tier: 'flex' }, 200)
    await call('GET', '/v1/agents/tools', {}, undefined, 200)
    await call('GET', '/v1/agents/skills', {}, undefined, 200)
    await call('POST', '/v1/agents', {}, {}, 400)
    await call('GET', '/v1/agents/{agent_id}', { agent_id: 'agent_missing' }, undefined, 404)
    await call('DELETE', '/v1/agents/{agent_id}', { agent_id: agent.id }, undefined, 200)
  })

  it('validates templates, environments, and files', async () => {
    const { call, origin } = await start()
    const template = await call('POST', '/v1/agents/environments/templates', {}, { name: 'py', config: { packages: ['numpy'] } }, 201)
    await call('GET', '/v1/agents/environments/templates', {}, undefined, 200)
    await call('GET', '/v1/agents/environments/templates/{template_id}', { template_id: template.id }, undefined, 200)
    await call('POST', '/v1/agents/environments/templates/{template_id}', { template_id: template.id }, { name: 'py2' }, 200)
    const env = await call('POST', '/v1/agents/environments', {}, {}, 201)
    await call('GET', '/v1/agents/environments', {}, undefined, 200)
    await call('GET', '/v1/agents/environments/{environment_id}', { environment_id: env.id }, undefined, 200)
    await call('POST', '/v1/agents/environments/{environment_id}/files', { environment_id: env.id }, { path: 'a/b.txt', content: 'hi' }, 201)
    const files = await call('GET', '/v1/agents/environments/{environment_id}/files', { environment_id: env.id }, undefined, 200)
    expect(files.data).toEqual([{ path: 'a/b.txt' }])
    const raw = await fetch(`${origin}/v1/agents/environments/${String(env.id)}/files/a/b.txt`)
    expect(raw.headers.get('content-type')).toBe('application/octet-stream')
    expect(await raw.text()).toBe('hi')
    await call('DELETE', '/v1/agents/environments/{environment_id}', { environment_id: env.id }, undefined, 200)
    await call('DELETE', '/v1/agents/environments/templates/{template_id}', { template_id: template.id }, undefined, 200)
    await call('GET', '/v1/agents/environments/{environment_id}', { environment_id: 'env_missing' }, undefined, 404)
  })

  it('validates sessions, input events, items, turns, and subresources', async () => {
    const { call, api, query } = await start()
    const created = await call('POST', '/v1/agents/sessions', {}, { agent: { model: 'deepseek-chat' }, metadata: { k: 'v' } }, 200)
    const id = created.id as string
    query.append(id, logEvent('turn/start', { turn: 1 }, 1))
    api.applySessionEvent(id, logEvent('turn/start', { turn: 1 }, 1))
    await call('GET', '/v1/agents/sessions', {}, undefined, 200)
    await call('GET', '/v1/agents/sessions/{session_id}', { session_id: id }, undefined, 200)
    await call('POST', '/v1/agents/sessions/{session_id}', { session_id: id }, { agent: { service_tier: 'flex', reasoning: { effort: 'low' } }, metadata: { a: 'b' } }, 200)
    await call('POST', '/v1/agents/sessions/{session_id}/events', { session_id: id }, {
      events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }],
    }, 200)
    await call('POST', '/v1/agents/sessions/{session_id}/events', { session_id: id }, { events: [{ type: 'agent.session.input.cancel' }] }, 200)
    await call('POST', '/v1/agents/sessions/{session_id}/events', { session_id: id }, {
      events: [{ type: 'agent.session.input.approval_response', id: 'nope', decision: 'approve' }],
    }, 404)
    await call('GET', '/v1/agents/sessions/{session_id}/items', { session_id: id }, undefined, 200)
    const turns = await call('GET', '/v1/agents/sessions/{session_id}/turns', { session_id: id }, undefined, 200)
    await call('GET', '/v1/agents/sessions/{session_id}/turns/{turn_id}', { session_id: id, turn_id: turns.data[0].id }, undefined, 200)
    await call('GET', '/v1/agents/sessions/{session_id}/artifacts', { session_id: id }, undefined, 200)
    await call('GET', '/v1/agents/sessions/{session_id}/subagents', { session_id: id }, undefined, 200)
    await call('GET', '/v1/agents/sessions/{session_id}/subagents/{subagent_id}', { session_id: id, subagent_id: 'x' }, undefined, 404)
    await call('DELETE', '/v1/agents/sessions/{session_id}', { session_id: id }, undefined, 200)
  })

  it('validates a scheduled prompt item', async () => {
    const { call, api, query } = await start()
    const created = await call('POST', '/v1/agents/sessions', {}, { agent: { model: 'deepseek-chat' } }, 200)
    const id = created.id as string
    const events = [
      logEvent('turn/start', { turn: 1 }, 1),
      logEvent('user/message', {
        content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nschedule_id_json: "schedule-a"\nreminder_prompt_json: "Check the build"' }],
        source: { kind: 'schedule' },
      }, 2),
    ]
    for (const event of events) {
      query.append(id, event)
      api.applySessionEvent(id, event)
    }
    const items = await call('GET', '/v1/agents/sessions/{session_id}/items', { session_id: id }, undefined, 200)
    expect(items.data).toMatchObject([{ role: 'user', source: 'schedule', schedule_id: 'schedule-a', content: [{ text: 'Check the build' }] }])
  })

  it('validates scheduled task requests and responses', async () => {
    const fake = new FakeSchedule()
    const { call } = await start(openAuthenticator, new MemoryStore(), fake)
    const timings = [
      { kind: 'after', after_seconds: 90 },
      { kind: 'at', at: '2026-12-01T09:00:00.000Z' },
      { kind: 'at', at: { date: '2026-12-01', time: '09:00', time_zone: 'Asia/Kuala_Lumpur' } },
      { kind: 'every', every_seconds: 3600 },
      { kind: 'daily', daily: { time: '08:00', time_zone: 'UTC' } },
      { kind: 'weekly', weekly: { time: '08:00', time_zone: 'UTC', weekdays: [1, 2, 3, 4, 5] } },
      { kind: 'cron', cron: { expression: '0 9 * * 1', time_zone: 'UTC' } },
      { kind: 'rrule', rrule: 'DTSTART:20261201T090000Z\nRRULE:FREQ=DAILY' },
    ]
    for (const timing of timings) {
      const task = await call('POST', '/v1/agents/schedules', {}, { title: 'T', prompt: 'P', timing, agent: { model: 'deepseek-chat' } }, 200)
      expect(task.timing.kind).toBe(timing.kind)
    }
    const created = await call('POST', '/v1/agents/schedules', {}, { title: 'Brief', prompt: 'Summarize', timing: timings[4], agent: { model: 'deepseek-chat' } }, 200)
    const params = { schedule_id: created.id as string }
    fake.deliveries.set(created.id, [{ scheduledAt: '2026-11-10T08:00:00.000Z', deliveredAt: '2026-11-10T08:00:01.000Z', messageId: 'msg_1', targetSessionId: created.session_id }])
    Object.assign(fake.entries.find(entry => entry.id === created.id)!, {
      executionActive: true,
      lastDelivery: { scheduledAt: '2026-11-10T08:00:00.000Z', deliveredAt: '2026-11-10T08:00:01.000Z', messageId: 'msg_1', targetSessionId: created.session_id },
    })
    const list = await call('GET', '/v1/agents/schedules', {}, undefined, 200)
    expect(list.data).toHaveLength(9)
    await call('GET', '/v1/agents/schedules/{schedule_id}', params, undefined, 200)
    const updated = await call('POST', '/v1/agents/schedules/{schedule_id}', params, { title: 'Renamed', timing: timings[6], revision: created.revision }, 200)
    await call('POST', '/v1/agents/schedules/{schedule_id}', params, { title: 'Stale', revision: created.revision }, 409)
    await call('POST', '/v1/agents/schedules/{schedule_id}', params, {}, 400)
    await call('POST', '/v1/agents/schedules/{schedule_id}/pause', params, undefined, 200)
    await call('POST', '/v1/agents/schedules/{schedule_id}/resume', params, undefined, 200)
    await call('POST', '/v1/agents/schedules/{schedule_id}/run', params, undefined, 200)
    fake.runPending = true
    await call('POST', '/v1/agents/schedules/{schedule_id}/run', params, undefined, 409)
    const runs = await call('GET', '/v1/agents/schedules/{schedule_id}/runs', params, undefined, 200)
    expect(runs.data).toHaveLength(1)
    await call('GET', '/v1/agents/schedules/{schedule_id}', { schedule_id: 'missing' }, undefined, 404)
    await call('DELETE', '/v1/agents/schedules/{schedule_id}', params, undefined, 200)
    expect(updated.title).toBe('Renamed')
  })

  it('validates the 501 answer without a schedule service', async () => {
    const { call } = await start()
    await call('GET', '/v1/agents/schedules', {}, undefined, 501)
  })

  it('validates subagent resources', async () => {
    const { call, api } = await start()
    const created = await call('POST', '/v1/agents/sessions', {}, { agent: { model: 'deepseek-chat' } }, 200)
    const id = created.id as string
    const registry = (api as unknown as { sessionRegistry: SessionRegistry }).sessionRegistry
    registry.ensureSubagent(id, 'child1')
    const params = { session_id: id, subagent_id: 'child1' }
    await call('GET', '/v1/agents/sessions/{session_id}/subagents', { session_id: id }, undefined, 200)
    await call('GET', '/v1/agents/sessions/{session_id}/subagents/{subagent_id}', params, undefined, 200)
    await call('GET', '/v1/agents/sessions/{session_id}/subagents/{subagent_id}/turns', params, undefined, 200)
    await call('GET', '/v1/agents/sessions/{session_id}/subagents/{subagent_id}/items', params, undefined, 200)
  })

  it('validates authentication errors', async () => {
    const { call, origin } = await start(createStaticKeyAuthenticator({ key: 'secret', owner: 'test', admin: true }))
    const res = await fetch(`${origin}/v1/agents`)
    expect(res.status).toBe(401)
    expect(spec.response('GET', '/v1/agents', 401, await res.json())).toEqual([])
    expect(call).toBeTypeOf('function')
    const noRoles: Authenticator = { authenticate: () => Promise.resolve({ ok: true as const, principal: { owner: 'x' as never, roles: new Set<never>() } }) }
    const forbidden = await start(noRoles)
    const denied = await fetch(`${forbidden.origin}/v1/agents`)
    expect(denied.status).toBe(403)
    expect(spec.response('GET', '/v1/agents', 403, await denied.json())).toEqual([])
  })

  it('validates a 503 while the store is unavailable', async () => {
    const { api, origin } = await start()
    api.failStore('down')
    const res = await fetch(`${origin}/v1/agents`)
    expect(res.status).toBe(503)
    expect(spec.response('GET', '/v1/agents', 503, await res.json())).toEqual([])
  })
})

describe('OpenAPI event stream', () => {
  /** Read SSE text until `count` frames arrived, then close the connection. */
  async function frames(url: string, count: number, headers: Record<string, string> = {}): Promise<Array<{ id?: string; event: string; data: unknown }>> {
    const res = await fetch(url, { headers })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const parse = () => text.split('\n\n').filter(block => block.includes('\n') && block.includes('data:'))
    while (parse().length < count) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    await reader.cancel()
    return parse().map((block) => {
      const lines = block.split('\n')
      const field = (name: string) => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
      const id = field('id')
      return { ...(id === undefined ? {} : { id }), event: field('event')!, data: JSON.parse(field('data')!) as unknown }
    })
  }

  it('validates every streamed frame against SessionEvent and keeps ids off ephemeral frames', async () => {
    const { call, api, query, origin } = await start()
    const created = await call('POST', '/v1/agents/sessions', {}, { agent: { model: 'deepseek-chat' } }, 200)
    const id = created.id as string
    for (const [seq, event] of [logEvent('turn/start', { turn: 1 }, 1), logEvent('turn/end', { turn: 1, reason: 'completed' }, 2)].entries()) {
      void seq
      query.append(id, event)
      api.applySessionEvent(id, event)
    }
    const live = await frames(`${origin}/v1/agents/sessions/${id}/events?stream=true`, 1)
    expect(live[0]!.id).toBeUndefined()
    const replay = await frames(`${origin}/v1/agents/sessions/${id}/events?stream=true`, 2, { 'last-event-id': '0' })
    expect(replay.length).toBeGreaterThanOrEqual(2)
    for (const frame of [...live, ...replay]) {
      expect(spec.schema('SessionEvent', frame.data), frame.event).toEqual([])
      expect((frame.data as { type: string }).type).toBe(frame.event)
    }
    expect(replay[0]!.id).toBe('1')
  })
})

describe('OpenAPI schema fixtures', () => {
  const agent = { id: 'agent_1', object: 'agent', created_at: 1, updated_at: 1, name: null, instructions: null, model: 'm', metadata: {}, tools: [] }
  const session = (required_actions: unknown[]) => ({
    id: 'sess_1', object: 'agent.session', created_at: 1, last_active_at: 1, status: 'requires_action', error: null,
    metadata: {}, vault_ids: [], agent, environment: { type: 'none' }, required_actions, usage: null,
  })

  it('accepts every required action variant', () => {
    const actions = [
      { type: 'function_call', name: 'lookup', arguments: { q: 1 }, turn_id: 'turn_1', call_id: 'c1' },
      { type: 'environment_connection', environment_id: 'env_1' },
      { type: 'approval', id: 'a1', kind: 'tool_approval', prompt: 'Approve bash', options: ['approve', 'deny'], tool_name: 'bash', call_id: 'c2' },
      { type: 'approval', id: 'q1', kind: 'user_question', prompt: 'Pick', options: [], questions: [{ id: 'x', question: 'Which?', options: [{ label: 'A' }], multiSelect: false }] },
    ]
    expect(spec.schema('AgentSession', session(actions))).toEqual([])
  })

  it('rejects malformed sessions', () => {
    expect(spec.schema('AgentSession', { ...session([]), status: 'sleeping' })).not.toEqual([])
    expect(spec.schema('AgentSession', session([{ type: 'approval', id: 'a', kind: 'weird', prompt: 'p', options: [] }]))).not.toEqual([])
  })

  it('accepts every input event and rejects an unknown one', () => {
    for (const event of [
      { type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }], model: 'm', reasoning: { effort: 'high' } },
      { type: 'agent.session.input.cancel' },
      { type: 'agent.session.input.tool_result', turn_id: 't', call_id: 'c', success: true, output: { ok: 1 } },
      { type: 'agent.session.input.tool_result', turn_id: 't', call_id: 'c', success: false, error: 'boom' },
      { type: 'agent.session.input.function_call_output', call_id: 'c', output: 'x' },
      { type: 'agent.session.input.approval_response', id: 'a', decision: 'answer', payload: { selected: ['A'] } },
    ]) {
      expect(spec.schema('InputEvent', event), JSON.stringify(event)).toEqual([])
    }
    expect(spec.schema('InputEvent', { type: 'agent.session.input.nope' })).not.toEqual([])
  })
})
