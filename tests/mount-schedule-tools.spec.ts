/**
 * In-chat schedule tools are owner-scoped: each owner lists, views and edits
 * only their own tasks; another owner's task and a task with no known owner
 * look like unknown ids.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ownerId, type OwnerId } from '../src/auth/authenticator.ts'
import { mountScheduleTools, ownedScheduleService, SCHEDULE_TOOL_NAMES, scheduleToolDefinitions } from '../src/mount-schedule-tools.ts'
import type { SessionIndexRow } from '../src/store/store.ts'
import { FakeSchedule } from './support/fake-schedule.ts'
import { MemoryStore } from './support/memory-store.ts'

const ALICE = ownerId('alice')
const BOB = ownerId('bob')

function row(id: string, owner: OwnerId): SessionIndexRow {
  const now = new Date()
  return { id, ownerId: owner, agentId: null, environmentId: null, projectId: null, dshSessionId: id, status: 'idle', lastError: null, model: 'm', reasoningEffort: null, body: null, createdAt: now, updatedAt: now }
}

let store: MemoryStore
let schedule: FakeSchedule

beforeEach(async () => {
  store = new MemoryStore()
  await store.ensureOwner(ALICE)
  await store.ensureOwner(BOB)
  await store.sessions.insert(row('sess_alice', ALICE))
  await store.sessions.insert(row('sess_bob', BOB))
  schedule = new FakeSchedule()
  schedule.add({ id: 'task_alice', target: { kind: 'session', sessionId: 'sess_alice' } })
  schedule.add({ id: 'task_bob', target: { kind: 'session', sessionId: 'sess_bob' } })
  // Delivers to new sessions; owned through the session that created it.
  schedule.add({ id: 'task_alice_new', target: { kind: 'new', create: {} }, involvedSessionIds: ['sess_alice'], status: 'paused' })
  // No indexed session: nobody's.
  schedule.add({ id: 'task_orphan', target: { kind: 'session', sessionId: 'sess_gone' }, involvedSessionIds: ['sess_gone'] })
})

/** DSH's tool definitions over the owner's view of the fake service. */
function toolsFor(owner: OwnerId): Map<string, ToolDefinition> {
  return scheduleToolDefinitions(ownedScheduleService({ schedule: () => schedule.asService(), ownersOf: store.sessions.ownersOf, owner }))
}

/** Run one tool as the root agent of `sessionId`. */
async function call(tools: Map<string, ToolDefinition>, name: string, args: Record<string, unknown>, sessionId: string): Promise<Record<string, unknown>> {
  const agent = { session: { id: sessionId, header: {} }, options: {}, ctx: { get: () => undefined } }
  return await tools.get(name)!.execute(args, { agent, signal: new AbortController().signal } as never) as Record<string, unknown>
}

const ids = (result: Record<string, unknown>) => (result['items'] as { id: string }[]).map(item => item.id)

describe('owner-scoped schedule tools', () => {
  it('builds every DSH schedule tool', () => {
    expect([...toolsFor(ALICE).keys()].sort()).toEqual([...SCHEDULE_TOOL_NAMES].sort())
  })

  it('lists only the owner\'s tasks, with totals and filters over them', async () => {
    const alice = await call(toolsFor(ALICE), 'schedule_list', {}, 'sess_alice')
    expect(ids(alice)).toEqual(['task_alice', 'task_alice_new'])
    expect(alice['total']).toBe(2)
    const bob = await call(toolsFor(BOB), 'schedule_list', {}, 'sess_bob')
    expect(ids(bob)).toEqual(['task_bob'])
    expect(bob['total']).toBe(1)
    const active = await call(toolsFor(ALICE), 'schedule_list', { active: true }, 'sess_alice')
    expect(ids(active)).toEqual(['task_alice'])
    const page = await call(toolsFor(ALICE), 'schedule_list', { limit: 1, offset: 1 }, 'sess_alice')
    expect(page).toMatchObject({ shown: 1, total: 2, limit: 1, offset: 1 })
    expect(ids(page)).toEqual(['task_alice_new'])
  })

  it('keeps the list page bounds and their error', async () => {
    // Checked on the service: under Vitest the tool package loads a second copy of
    // `ScheduleInputError`, so the tool would report `internal_error`; one install shares it.
    const service = ownedScheduleService({ schedule: () => schedule.asService(), ownersOf: store.sessions.ownersOf, owner: ALICE })
    await expect(service.list({ limit: 0 })).rejects.toMatchObject({ name: 'ScheduleInputError', code: 'invalid_rule' })
    await expect(service.list({ offset: -1 })).rejects.toMatchObject({ code: 'invalid_rule' })
  })

  it('views the owner\'s task; another owner\'s and an ownerless task are not found', async () => {
    const tools = toolsFor(ALICE)
    expect(await call(tools, 'schedule_view', { id: 'task_alice' }, 'sess_alice')).toMatchObject({ id: 'task_alice', kind: 'daily' })
    expect(await call(tools, 'schedule_view', { id: 'task_bob' }, 'sess_alice')).toEqual({ id: 'task_bob', code: 'schedule_not_found' })
    expect(await call(tools, 'schedule_view', { id: 'task_orphan' }, 'sess_alice')).toEqual({ id: 'task_orphan', code: 'schedule_not_found' })
    expect(await call(toolsFor(BOB), 'schedule_view', { id: 'task_alice' }, 'sess_bob')).toEqual({ id: 'task_alice', code: 'schedule_not_found' })
  })

  it('edits and deletes only the owner\'s tasks; cross-owner ids change nothing', async () => {
    const alice = toolsFor(ALICE)
    const bob = toolsFor(BOB)
    expect(await call(bob, 'schedule_edit', { id: 'task_alice', action: 'update', title: 'Hijacked' }, 'sess_bob'))
      .toEqual({ id: 'task_alice', code: 'schedule_not_found' })
    expect(await call(bob, 'schedule_edit', { id: 'task_alice', action: 'delete' }, 'sess_bob'))
      .toEqual({ id: 'task_alice', code: 'schedule_not_found' })
    expect(await call(alice, 'schedule_edit', { id: 'task_orphan', action: 'delete' }, 'sess_alice'))
      .toEqual({ id: 'task_orphan', code: 'schedule_not_found' })
    expect(schedule.mutatingCalls()).toEqual([])

    expect(await call(alice, 'schedule_edit', { id: 'task_alice', action: 'update', title: 'Renamed' }, 'sess_alice'))
      .toMatchObject({ id: 'task_alice', title: 'Renamed' })
    expect(await call(bob, 'schedule_edit', { id: 'task_bob', action: 'delete' }, 'sess_bob')).toEqual({ id: 'task_bob', deleted: true })
    expect(schedule.entries.map(entry => entry.id)).toEqual(['task_alice', 'task_alice_new', 'task_orphan'])
    expect(schedule.entries[0]!.title).toBe('Renamed')
  })

  it('creates a task on the caller\'s session, which then belongs to the caller only', async () => {
    const created = await call(toolsFor(BOB), 'schedule_create', { title: 'Ping', prompt: 'ping', rrule: 'DTSTART:20261201T080000Z\nRRULE:FREQ=DAILY', target: 'this_session' }, 'sess_bob')
    const id = created['id'] as string
    expect(created).toMatchObject({ target: { kind: 'session', sessionId: 'sess_bob' } })
    expect(ids(await call(toolsFor(BOB), 'schedule_list', {}, 'sess_bob'))).toContain(id)
    expect(ids(await call(toolsFor(ALICE), 'schedule_list', {}, 'sess_alice'))).not.toContain(id)
  })
})

describe('mountScheduleTools', () => {
  function agentScope(): { agentCtx: Context; registered: string[] } {
    const registered: string[] = []
    const agentCtx = { tools: { register: (definition: { name: string }) => { registered.push(definition.name); return () => {} } } } as unknown as Context
    return { agentCtx, registered }
  }
  const deps = () => ({ schedule: () => schedule.asService(), ownersOf: store.sessions.ownersOf, owner: ALICE })

  it('registers the four tools on the agent scope, where they shadow the preset\'s', () => {
    const { agentCtx, registered } = agentScope()
    mountScheduleTools(agentCtx, deps())
    expect(registered.sort()).toEqual([...SCHEDULE_TOOL_NAMES].sort())
  })

  it('skips tools the session\'s host_tools mask hides (own-scope tools are not masked)', () => {
    const denied = agentScope()
    mountScheduleTools(denied.agentCtx, { ...deps(), hostTools: { deny: ['schedule_edit'] } })
    expect(denied.registered.sort()).toEqual(['schedule_create', 'schedule_list', 'schedule_view'])
    const allowed = agentScope()
    mountScheduleTools(allowed.agentCtx, { ...deps(), hostTools: { allow: ['schedule_list', 'read'] } })
    expect(allowed.registered).toEqual(['schedule_list'])
  })

  it('registers nothing without a Host schedule service', () => {
    const { agentCtx, registered } = agentScope()
    mountScheduleTools(agentCtx, { ...deps(), schedule: () => undefined })
    expect(registered).toEqual([])
  })
})
