import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { materializeAgent } from '../src/agent-records.ts'
import { ownerId } from '../src/auth/authenticator.ts'
import { NO_STORED_CONFIG, RecoveryProbeError, RecoveryUnavailableError, recoverSessions, recoveryUnavailable } from '../src/recovery.ts'
import type { SessionIndexRow } from '../src/store/store.ts'
import { MemoryStore } from './support/memory-store.ts'

const OWNER = ownerId('o')

function row(id: string, status: SessionIndexRow['status'], withBody = true): SessionIndexRow {
  const at = new Date('2026-11-08T10:00:00.000Z')
  return {
    id,
    ownerId: OWNER,
    agentId: null,
    environmentId: null,
    dshSessionId: id,
    status,
    lastError: null,
    model: 'deepseek-chat',
    reasoningEffort: null,
    body: withBody ? { agent: materializeAgent({ model: 'deepseek-chat' }), environment: { type: 'none' }, metadata: {}, vault_ids: [] } : null,
    createdAt: at,
    updatedAt: at,
  }
}

async function seeded(...rows: SessionIndexRow[]): Promise<MemoryStore> {
  const store = new MemoryStore()
  await store.ensureOwner(OWNER)
  for (const next of rows) await store.sessions.insert(next)
  return store
}

describe('recoverSessions', () => {
  it('resumes in_progress and requires_action rows and leaves their status alone', async () => {
    const store = await seeded(row('sess_a', 'in_progress'), row('sess_b', 'requires_action'), row('sess_idle', 'idle'))
    const resume = vi.fn<(r: SessionIndexRow) => Promise<void>>(() => Promise.resolve())
    const result = await recoverSessions({ store, resume })

    expect(result).toEqual({ resumed: ['sess_a', 'sess_b'], interrupted: [] })
    expect(resume.mock.calls.map(([called]) => called.id)).toEqual(['sess_a', 'sess_b'])
    expect((await store.sessions.get('sess_a', 'any'))?.status).toBe('in_progress')
    expect((await store.sessions.get('sess_b', 'any'))?.status).toBe('requires_action')
  })

  it('marks sessions that cannot be resumed interrupted with the error message', async () => {
    const store = await seeded(row('sess_a', 'in_progress'), row('sess_b', 'in_progress'))
    const resume = vi.fn<(r: SessionIndexRow) => Promise<void>>(r => r.id === 'sess_a' ? Promise.reject(new Error('log is corrupt')) : Promise.resolve())
    const result = await recoverSessions({ store, resume })

    expect(result).toEqual({ resumed: ['sess_b'], interrupted: [{ id: 'sess_a', reason: 'log is corrupt' }] })
    expect(await store.sessions.get('sess_a', 'any')).toMatchObject({ status: 'interrupted', lastError: 'log is corrupt' })
    expect((await store.sessions.get('sess_b', 'any'))?.status).toBe('in_progress')
  })

  it('marks rows without a stored setup interrupted without trying to resume them', async () => {
    const store = await seeded(row('sess_old', 'in_progress', false))
    const resume = vi.fn<(r: SessionIndexRow) => Promise<void>>(() => Promise.resolve())
    const result = await recoverSessions({ store, resume })

    expect(resume).not.toHaveBeenCalled()
    expect(result.interrupted).toEqual([{ id: 'sess_old', reason: NO_STORED_CONFIG }])
    expect(await store.sessions.get('sess_old', 'any')).toMatchObject({ status: 'interrupted', lastError: NO_STORED_CONFIG })
  })

  it('treats every resume rejection as that session failing and keeps going', async () => {
    const store = await seeded(row('sess_a', 'in_progress'), row('sess_b', 'in_progress'), row('sess_c', 'in_progress'))
    const resume = vi.fn<(r: SessionIndexRow) => Promise<void>>(r => r.id === 'sess_b' ? Promise.resolve() : Promise.reject(new Error('no agent factory registered')))
    const result = await recoverSessions({ store, resume })
    expect(result.resumed).toEqual(['sess_b'])
    expect(result.interrupted.map(entry => entry.id)).toEqual(['sess_a', 'sess_c'])
  })

  it('reports a missing agent factory or session persistence before any resume', () => {
    expect(recoveryUnavailable({ factory: {} }, {})).toBeUndefined()
    expect(recoveryUnavailable({ factory: undefined }, {})).toBeInstanceOf(RecoveryUnavailableError)
    expect(() => recoveryUnavailable({}, {})).toThrow(RecoveryProbeError)
    expect(() => recoveryUnavailable(undefined, {})).toThrow(RecoveryProbeError)
    expect(recoveryUnavailable({ factory: {} }, undefined)?.message).toMatch(/persistence/)
  })

  it('does nothing when no session is running', async () => {
    const store = await seeded(row('sess_idle', 'idle'), row('sess_failed', 'failed'))
    expect(await recoverSessions({ store, resume: () => Promise.reject(new Error('unused')) })).toEqual({ resumed: [], interrupted: [] })
  })
})

describe('recoveryUnavailable against the real agent registry', () => {
  it('is unavailable before a factory is registered and available after setFactory', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    // Constructed directly: loading it as a plugin trips a const-enum import under this repository's Vite.
    const registry = new AgentRegistry(ctx)
    expect(recoveryUnavailable(registry, {})).toBeInstanceOf(RecoveryUnavailableError)
    const dispose = registry.setFactory({
      createAgent: () => Promise.reject(new Error('unused')),
      resume: () => Promise.reject(new Error('unused')),
    })
    expect(recoveryUnavailable(registry, {})).toBeUndefined()
    dispose()
    expect(recoveryUnavailable(registry, {})).toBeInstanceOf(RecoveryUnavailableError)
  })
})
