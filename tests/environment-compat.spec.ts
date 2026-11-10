import { describe, expect, it } from 'vitest'
import type { EnvironmentRecord, EnvironmentTemplate } from '../src/environment-types.ts'
import { sdkStatus, toSdkEnvironment } from '../src/environment/environment-compat.ts'

const record = (over: Partial<EnvironmentRecord> = {}): EnvironmentRecord => ({
  id: 'env_1', object: 'environment', status: 'connected', provider: 'local', provider_metadata: { workspace_directory: '/w/a' }, created_at: 5, ...over,
})

describe('sdkStatus', () => {
  it('maps our statuses onto the SDK values', () => {
    expect(['pending', 'connected', 'failed', 'cleanup', 'deleted'].map(s => sdkStatus(s as never))).toEqual(['pending', 'connected', 'failed', 'disconnected', 'expired'])
  })
})

describe('toSdkEnvironment', () => {
  it('returns every SDK field for a plain local environment, plus our extensions', () => {
    expect(toSdkEnvironment(record())).toEqual({
      id: 'env_1',
      object: 'agent.environment',
      type: 'self_hosted',
      status: 'connected',
      files: [],
      plugins: [],
      skills: [],
      provider: 'local',
      provider_metadata: { workspace_directory: '/w/a' },
      created_at: 5,
    })
  })

  it('reports a provider-provisioned environment as openai_hosted and carries template resources and extensions', () => {
    const template: EnvironmentTemplate = {
      id: 'tpl_1', object: 'environment.template', name: 't', provider: 'docker', created_at: 1,
      config: {
        files: [{ type: 'inline', path: '/workspace/a.txt', data: Buffer.from('hey').toString('base64') }, { type: 'file_id', path: '/workspace/b', file_id: 'file_9' }],
        skills: [{ skill_id: 'skill_1' }, { name: 'mine', description: 'd' }],
        plugins: [{ name: 'p', description: 'q' }],
      },
    }
    const out = toSdkEnvironment(record({ provider: 'docker', provider_metadata: { container_id: 'c1' }, template_id: 'tpl_1', session_id: 'sess_1', status: 'failed', error: 'boom', updated_at: 9 }), template)
    expect(out).toMatchObject({
      type: 'openai_hosted',
      status: 'failed',
      files: [{ type: 'inline', id: 'file_1', path: '/workspace/a.txt', size_bytes: 3 }, { type: 'file_id', id: 'file_2', file_id: 'file_9', path: '/workspace/b', size_bytes: 0 }],
      plugins: [{ type: 'inline', name: 'p', description: 'q' }],
      skills: [{ type: 'skill_reference', skill_id: 'skill_1', name: '', description: '', version: 'latest' }, { type: 'inline', name: 'mine', description: 'd' }],
      provider: 'docker',
      provider_metadata: { container_id: 'c1' },
      template_id: 'tpl_1',
      session_id: 'sess_1',
      error: 'boom',
      updated_at: 9,
    })
  })

  it('maps cleanup and deleted records to the SDK statuses', () => {
    expect(toSdkEnvironment(record({ status: 'cleanup' })).status).toBe('disconnected')
    expect(toSdkEnvironment(record({ status: 'deleted' })).status).toBe('expired')
  })
})
