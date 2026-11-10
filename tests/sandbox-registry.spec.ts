import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalProvider } from '../src/environment/local.ts'
import type { OwnerId } from '../src/auth/authenticator.ts'
import type { SandboxProvider } from '../src/sandbox/contract.ts'
import { SandboxRegistry, UnknownSandboxProviderError } from '../src/sandbox/registry.ts'

const fake = (kind: string, exec = false): SandboxProvider => ({
  kind,
  capabilities: { templateFields: ['image'], files: true, exec },
  async create() { return { status: 'connected', workspacePath: '/workspace' } },
  async status() { return 'connected' },
  async destroy() {},
  async listFiles() { return [] },
  async readFile() { return new Uint8Array() },
  async writeFile() {},
})

describe('SandboxRegistry', () => {
  it('registers, gets, requires and lists providers, marking the default', () => {
    const registry = new SandboxRegistry('local')
    const local = fake('local', true)
    const docker = fake('docker')
    registry.register(local)
    registry.register(docker)
    expect(registry.get('docker')).toBe(docker)
    expect(registry.require('local')).toBe(local)
    expect(registry.default()).toBe(local)
    expect(registry.list()).toEqual([
      { name: 'local', capabilities: local.capabilities, default: true },
      { name: 'docker', capabilities: docker.capabilities, default: false },
    ])
  })

  it('rejects a duplicate name and unregisters', () => {
    const registry = new SandboxRegistry('local')
    const off = registry.register(fake('local'))
    expect(() => registry.register(fake('local'))).toThrow(/already registered/)
    off()
    expect(registry.get('local')).toBeUndefined()
  })

  it('names the registered providers when one is unknown, and when the default is missing', () => {
    const registry = new SandboxRegistry('local')
    registry.register(fake('docker'))
    expect(() => registry.require('nope')).toThrow(UnknownSandboxProviderError)
    expect(() => registry.require('nope')).toThrow(/"nope".*docker/)
    expect(() => registry.default()).toThrow(UnknownSandboxProviderError)
  })
})

describe('local provider as a SandboxProvider', () => {
  it('declares itself, runs agents, and applies inline files (SDK shape and the legacy starter files)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentry-sbx-'))
    const local = createLocalProvider(root)
    expect(local.kind).toBe('local')
    expect(local.capabilities).toEqual({ templateFields: ['files'], files: true, exec: true })
    const owner = 'a' as OwnerId
    const created = await local.create(owner, 'env_1', {
      template: { files: [{ type: 'inline', path: '/workspace/notes/readme.md', data: Buffer.from('hello').toString('base64') }], starter_files: [{ path: 'old.txt', content: 'legacy' }] },
    })
    const record = { id: 'env_1', object: 'environment' as const, status: created.status, provider: 'local', provider_metadata: { workspace_directory: created.workspacePath }, created_at: 1 }
    // SDK files win over legacy starter files, which are only read when no SDK files are given.
    expect(await local.listFiles(record)).toEqual(['notes/readme.md'])
    expect(new TextDecoder().decode(await local.readFile(record, 'notes/readme.md'))).toBe('hello')
    await local.destroy(record)
    const legacy = await local.create(owner, 'env_2', { template: { starter_files: [{ path: 'old.txt', content: 'legacy' }] } })
    expect(await local.listFiles({ ...record, id: 'env_2', provider_metadata: { workspace_directory: legacy.workspacePath } })).toEqual(['old.txt'])
  })

  it('refuses a Files API reference before creating anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentry-sbx-'))
    const local = createLocalProvider(root)
    await expect(local.create('a' as OwnerId, 'env_3', { template: { files: [{ type: 'file_id', path: '/workspace/x', file_id: 'file_1' }] } })).rejects.toThrow(/Files API reference/)
    await expect(stat(join(root, 'a', 'env_3'))).rejects.toThrow()
  })

  it('refuses a file path that escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentry-sbx-'))
    const local = createLocalProvider(root)
    await expect(local.create('a' as OwnerId, 'env_4', { template: { files: [{ type: 'inline', path: '/workspace/../../x', data: 'eA==' }] } })).rejects.toThrow(/escapes/)
  })
})
