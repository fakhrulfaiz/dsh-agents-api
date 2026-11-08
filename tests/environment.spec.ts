import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownerId } from '../src/auth/authenticator.ts'
import { CodeboxClient, createCodeboxProvider } from '../src/environment/codebox.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import type { EnvironmentRecord } from '../src/environment-types.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentry-env-'))
  dirs.push(dir)
  return dir
}

function localRecord(id: string, workspace: string): EnvironmentRecord {
  return {
    id,
    object: 'environment',
    status: 'connected',
    provider: 'local',
    provider_metadata: { workspace_directory: workspace },
    created_at: 1,
  }
}

describe('local environment provider', () => {
  it('local provider isolates owners', async () => {
    const root = await tempRoot()
    const provider = createLocalProvider(root)
    expect(provider.kind).toBe('local')
    const created = await provider.create(ownerId('A'), 'e1', {})
    expect(created).toEqual({ status: 'connected', workspacePath: join(root, 'A', 'e1') })
    expect((await stat(join(root, 'A', 'e1'))).isDirectory()).toBe(true)
    const record = localRecord('e1', created.workspacePath)
    await provider.writeFile(record, 'src/a.txt', new TextEncoder().encode('hi'))
    expect(new TextDecoder().decode(await provider.readFile(record, '/workspace/src/a.txt'))).toBe('hi')
    expect(await provider.listFiles(record)).toEqual(['src/a.txt'])
    await expect(provider.readFile(record, '../B/x')).rejects.toThrow(/escapes/u)
    await expect(provider.writeFile(record, '../../B/e2/x', new Uint8Array())).rejects.toThrow(/escapes/u)
    expect(await provider.status(record)).toBe('connected')
    await provider.destroy(record)
    expect(await provider.status(record)).toBe('failed')
  })

  it('rejects owner and environment ids that are not single path segments', async () => {
    const provider = createLocalProvider(await tempRoot())
    await expect(provider.create(ownerId('..'), 'e1', {})).rejects.toThrow(/owner/u)
    await expect(provider.create(ownerId('a/b'), 'e1', {})).rejects.toThrow(/owner/u)
    await expect(provider.create(ownerId('A'), '../e1', {})).rejects.toThrow(/environment/u)
  })

  it('refuses a record whose workspace lies outside the root', async () => {
    const provider = createLocalProvider(await tempRoot())
    await expect(provider.listFiles(localRecord('e1', '/etc'))).rejects.toThrow(/outside/u)
  })
})

describe('codebox environment provider', () => {
  it('keeps the Codebox client behind the provider interface', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
      return new Response(JSON.stringify({ id: 'box_1', status: 'running', image: 'base' }), { status: 200 })
    }) as unknown as typeof fetch
    const provider = createCodeboxProvider(new CodeboxClient({ baseUrl: 'http://codebox', apiKey: 'k' }, fetchImpl), {
      image: 'base',
      readyTimeoutSeconds: 1,
      budgetInstanceId: '',
    })
    expect(provider.kind).toBe('codebox')
    const created = await provider.create(ownerId('A'), 'env_1', {})
    expect(created).toEqual({ status: 'connected', workspacePath: '/workspace', codeboxId: 'box_1' })
    const record: EnvironmentRecord = {
      id: 'env_1',
      object: 'environment',
      status: 'connected',
      provider: 'codebox',
      provider_metadata: { codebox_id: 'box_1' },
      created_at: 1,
    }
    expect(await provider.status(record)).toBe('connected')
    await provider.destroy(record)
    expect(calls).toContain('DELETE http://codebox/codebox/api/codeboxes/box_1')
  })
})
