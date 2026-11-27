/**
 * Project defaults on session create: explicit request fields win.
 */

import { describe, expect, it } from 'vitest'
import { resolveProjectDefaults } from '../src/session-project.ts'
import type { OAIProject } from '../src/types.ts'

const PROJECT = {
  id: 'proj_1',
  object: 'project',
  name: 'Work',
  status: 'active',
  pinned: false,
  agent_id: 'agent_project',
  environment: { type: 'local', workspace_directory: '/tmp/project-workspace' },
  archived_at: null,
  created_at: 100,
  updated_at: 100,
} as const satisfies OAIProject

describe('resolveProjectDefaults', () => {
  it('uses project agent and environment when request omits them', () => {
    const body = { metadata: { title: 'Chat' } }
    const resolved = resolveProjectDefaults(body, PROJECT)

    expect(resolved).toEqual({
      metadata: { title: 'Chat' },
      agent_id: 'agent_project',
      environment: { type: 'local', workspace_directory: '/tmp/project-workspace' },
      project_id: 'proj_1',
    })
    expect(resolved.agent_id).toBe(PROJECT.agent_id)
    expect(resolved.environment).toBe(PROJECT.environment)
    // The request is not mutated.
    expect(body).toEqual({ metadata: { title: 'Chat' } })
  })

  it('keeps explicit agent and environment over project defaults', () => {
    const explicitEnvironment = { type: 'none' } as const
    const body = { agent_id: 'agent_explicit', environment: explicitEnvironment, input: 'hello' }
    const resolved = resolveProjectDefaults(body, PROJECT)

    expect(resolved).toEqual({
      agent_id: 'agent_explicit',
      environment: explicitEnvironment,
      input: 'hello',
      project_id: 'proj_1',
    })
    expect(resolved.agent_id).toBe('agent_explicit')
    expect(resolved.environment).toBe(explicitEnvironment)
  })

  it('normalizes a null project id to unfiled', () => {
    const body = { project_id: null, agent: { model: 'deepseek-chat' } }
    const resolved = resolveProjectDefaults(body, null)

    expect(resolved).toEqual({ project_id: null, agent: { model: 'deepseek-chat' } })
    expect(resolved.project_id).toBeNull()
  })
})
