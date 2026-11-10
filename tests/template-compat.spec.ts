import { describe, expect, it } from 'vitest'
import type { EnvironmentTemplate } from '../src/environment-types.ts'
import { normalizeTemplateConfig, parseTemplateInput, requestedFields, toSdkTemplate, unsupportedFields } from '../src/environment/template-compat.ts'
import type { SandboxProvider } from '../src/sandbox/contract.ts'

const provider = (templateFields: SandboxProvider['capabilities']['templateFields']): SandboxProvider => ({
  kind: 'fake',
  capabilities: { templateFields, files: true, exec: true },
  async create() { return { status: 'connected', workspacePath: '/workspace' } },
  async status() { return 'connected' },
  async destroy() {},
  async listFiles() { return [] },
  async readFile() { return new Uint8Array() },
  async writeFile() {},
})

const legacy: EnvironmentTemplate = {
  id: 'tpl_1',
  object: 'environment.template',
  name: 'old',
  provider: 'codebox',
  config: { image: 'base', setup: 'make', packages: ['git'], starter_files: [{ path: 'a.txt', content: 'x' }], default_env: { K: 'v' } },
  created_at: 10,
}

describe('normalizeTemplateConfig', () => {
  it('maps the Codebox-era layout onto the SDK fields and is idempotent', () => {
    const once = normalizeTemplateConfig(legacy.config)
    expect(once).toEqual({
      image: 'base',
      packages: { system: ['git'] },
      files: [{ type: 'inline', path: '/workspace/a.txt', data: Buffer.from('x').toString('base64') }],
      env: { K: 'v' },
      setup_commands: [{ command: 'make' }],
    })
    expect(normalizeTemplateConfig(once)).toEqual(once)
  })

  it('lets SDK fields win over legacy ones', () => {
    expect(normalizeTemplateConfig({ env: { A: '1' }, default_env: { B: '2' } }).env).toEqual({ A: '1' })
  })
})

describe('toSdkTemplate', () => {
  it('returns the SDK object with every SDK field, and our extensions', () => {
    const out = toSdkTemplate(legacy, provider(['files']))
    expect(out).toMatchObject({
      id: 'tpl_1',
      object: 'agent.environment.template',
      name: 'old',
      created_at: 10,
      updated_at: 10,
      capability_directories: [],
      network: { access: 'enabled', allowed_domains: [] },
      packages: { npm: [], python: [], system: ['git'] },
      plugins: [],
      skills: [],
      provider: 'codebox',
      image: 'base',
    })
    expect(out.files).toEqual([{ type: 'inline', path: '/workspace/a.txt', size_bytes: 1 }])
    // Confidential parts never come back.
    expect(JSON.stringify(out)).not.toContain('"data"')
    expect(out).not.toHaveProperty('env')
    expect(out).not.toHaveProperty('setup_commands')
  })

  it('lists the fields the provider cannot apply', () => {
    const out = toSdkTemplate(legacy, provider(['files']))
    expect(out.unsupported_fields).toEqual(['env', 'packages', 'setup_commands', 'image'])
    expect(toSdkTemplate(legacy, undefined).unsupported_fields).toContain('files')
  })
})

describe('requested and unsupported fields', () => {
  it('counts a field only when it asks for something', () => {
    expect(requestedFields({ network: { access: 'enabled' }, files: [], env: {}, packages: { npm: [] } })).toEqual([])
    expect(requestedFields({ network: { access: 'disabled' }, skills: [{ skill_id: 's' }] })).toEqual(['network', 'skills'])
  })

  it('reports unsupported network and skills for a files-only provider, nothing for a supported one', () => {
    const config = { network: { access: 'disabled' as const }, skills: [{ skill_id: 's' }], files: [{ type: 'inline' as const, path: '/workspace/a', data: 'eA==' }] }
    expect(unsupportedFields(config, provider(['files']))).toEqual(['network', 'skills'])
    expect(unsupportedFields(config, provider(['files', 'network', 'skills']))).toEqual([])
  })
})

describe('parseTemplateInput', () => {
  it('accepts the SDK create params and the extensions', () => {
    const parsed = parseTemplateInput({
      name: 'ci',
      provider: 'docker',
      image: 'node:24',
      env: { A: '1' },
      network: { access: 'restricted', allowed_domains: ['example.com'] },
      packages: { npm: ['x'], python: [], system: [] },
      files: [{ type: 'inline', path: '/workspace/a', data: 'eA==' }, { type: 'file_id', path: '/workspace/b', file_id: 'file_1' }],
      setup_commands: [{ command: 'npm ci', cwd: '/workspace' }],
      skills: [{ type: 'skill_reference', skill_id: 'skill_1' }],
      plugins: [],
      capability_directories: ['/workspace/.agents'],
      unknown_field: 'ignored',
    })
    expect(parsed).toEqual({
      name: 'ci',
      provider: 'docker',
      config: {
        image: 'node:24',
        env: { A: '1' },
        network: { access: 'restricted', allowed_domains: ['example.com'] },
        packages: { npm: ['x'], python: [], system: [] },
        files: [{ type: 'inline', path: '/workspace/a', data: 'eA==' }, { type: 'file_id', path: '/workspace/b', file_id: 'file_1' }],
        setup_commands: [{ command: 'npm ci', cwd: '/workspace' }],
        skills: [{ type: 'skill_reference', skill_id: 'skill_1' }],
        plugins: [],
        capability_directories: ['/workspace/.agents'],
      },
    })
  })

  it('still accepts the earlier nested body with Codebox-era fields', () => {
    const parsed = parseTemplateInput({ name: 'old', config: { image: 'base', setup: 'make', packages: ['git'], starter_files: [{ path: 'a.txt', content: 'x' }], default_env: { K: 'v' } } })
    expect(parsed).toEqual({ name: 'old', config: { image: 'base', setup: 'make', packages: ['git'], starter_files: [{ path: 'a.txt', content: 'x' }], default_env: { K: 'v' } } })
    expect(parseTemplateInput({ config: { env: { A: '1' } }, env: { B: '2' } })).toEqual({ config: { env: { B: '2' } } })
  })

  it('rejects malformed known fields with a message, but not unsupported ones', () => {
    expect(parseTemplateInput({ network: { access: 'nope' } })).toEqual({ error: expect.stringContaining('network.access') })
    expect(parseTemplateInput({ files: [{ type: 'inline', path: '/x' }] })).toEqual({ error: expect.stringContaining('"/x"') })
    expect(parseTemplateInput({ env: { A: 1 } })).toEqual({ error: expect.stringContaining('env') })
    expect(parseTemplateInput('x')).toEqual({ error: expect.stringContaining('object') })
    expect(parseTemplateInput({})).toEqual({ config: {} })
  })
})
