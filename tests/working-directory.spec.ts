/**
 * `@agentry/api/working-directory` on the real DSH services: the host-level service hands a sandbox
 * Agent's directory check to the service its preset mounts in the sandbox, so a sandbox session's
 * `/workspace` need not exist on the API host.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import AgentryWorkingDirectory from '../src/working-directory.ts'

// DSH's services load `@deepseek-ai/dsh-scope` from its built entry; use that same copy (its scope tag is a module-private symbol).
const { bindScopeParent, createScope } = (await import(pathToFileURL(resolve(process.env['DSH_ROOT']!, 'packages/core/scope/lib/index.js')).href)) as typeof import('@deepseek-ai/dsh-scope')

/** A folder that exists only "inside the sandbox" (never on this host). */
const SANDBOX_WORKSPACE = '/agentry-test-no-such-host-folder/workspace'

async function composed() {
  const hostDir = await mkdtemp(join(tmpdir(), 'agentry-wd-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(hostDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
  await ctx.plugin(LocalFileSystem, { cwd: hostDir })
  // The host-level row, mounted at startup before any sandbox preset is registered.
  await ctx.plugin(AgentryWorkingDirectory)
  // The sandbox preset: a scope whose isolated realm has its own fs (the sandbox's) and its own dsh-working-directory.
  const presetKey = {}
  const sandbox = createScope(ctx, presetKey).ctx.isolate('fs').isolate('workingDirectory')
  const stats: string[] = []
  await sandbox.plugin({
    name: 'fake-sandbox-fs',
    apply(inner: Context) {
      inner.provide('fs', {
        resolve: async (path: string) => path,
        stat: async (path: string) => { stats.push(path); return path === SANDBOX_WORKSPACE ? { type: 'directory' } : undefined },
        processPath: (path: string) => path,
      })
    },
  })
  await sandbox.plugin(WorkingDirectoryService)
  const sandboxService = sandbox.get('workingDirectory') as WorkingDirectoryService
  const sandboxAgents = new Set<Agent>()
  await ctx.plugin({
    name: 'fake-agent-presets',
    apply(inner: Context) {
      inner.provide('agentPresets', { serviceFor: (agent: Agent, name: string) => (name === 'workingDirectory' && sandboxAgents.has(agent) ? sandboxService : undefined) })
    },
  })
  const open = (id: string, cwd: string, inSandbox: boolean): Agent => {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
    const agent = { session, ctx, inject: () => {} } as unknown as Agent
    if (inSandbox) {
      sandboxAgents.add(agent)
      bindScopeParent(agent, presetKey)
    }
    return agent
  }
  return { ctx, hostDir, open, stats }
}

describe('Agentry working-directory service', () => {
  it('assembles a sandbox session whose workspace exists only in the sandbox', async () => {
    const { ctx, open, stats } = await composed()
    const agent = open('sbx-session', SANDBOX_WORKSPACE, true)
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(renderContextSnapshot(assembly)).toContain(`Current working directory: ${JSON.stringify(SANDBOX_WORKSPACE)}.`)
    expect(stats).toContain(SANDBOX_WORKSPACE)
    await expect(ctx.workingDirectory.ensure(agent)).resolves.toBe(SANDBOX_WORKSPACE)
  })

  it('still checks a host session on the host, as DSH does', async () => {
    const { ctx, hostDir, open, stats } = await composed()
    const agent = open('host-session', hostDir, false)
    await expect(ctx.workingDirectory.ensure(agent)).resolves.toBe(hostDir)
    const missing = open('host-missing', join(hostDir, 'gone'), false)
    await expect(ctx.workingDirectory.ensure(missing)).rejects.toThrow('directory does not exist')
    expect(stats).toEqual([])
  })

  it('stock DSH service fails the same sandbox session (the reason for the replacement)', async () => {
    const hostDir = await mkdtemp(join(tmpdir(), 'agentry-wd-'))
    const ctx = new Context()
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(hostDir, { recursive: true, force: true })
    })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
    await ctx.plugin(LocalFileSystem, { cwd: hostDir })
    await ctx.plugin(WorkingDirectoryService)
    const session = ctx.sessions.create(SessionId('stock'), { meta: { cwd: SANDBOX_WORKSPACE } })
    const agent = { session, ctx, inject: () => {} } as unknown as Agent
    await expect(ctx.systemPrompt.assemble({ agent })).rejects.toThrow('directory does not exist')
  })
})
