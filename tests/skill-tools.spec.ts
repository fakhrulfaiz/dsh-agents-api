/** Chat tools `skill_create` and `skill_install`: approval first, then an active chat skill. */

import { mkdtemp } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ownerId } from '../src/auth/authenticator.ts'
import { materializeAgent } from '../src/agent-records.ts'
import { mountSkillTools } from '../src/skills/tools.ts'
import { MemoryStore } from './support/memory-store.ts'

const OWNER = ownerId('dev')
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) })))
})

type Tool = { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }
type Handler = (exec: { name: string; arguments: unknown }, next: () => Promise<unknown>) => Promise<unknown>

async function mount(agentId?: string) {
  const store = new MemoryStore()
  await store.ensureOwner(OWNER)
  const root = await mkdtemp(join(tmpdir(), 'skill-tools-'))
  const tools: Tool[] = []
  let handler: Handler | undefined
  const agentCtx = { tools: { register: (t: Tool) => { tools.push(t) } }, on: (_event: string, h: Handler) => { handler = h } } as unknown as Context
  let invalidated = 0
  const saved = agentId === undefined ? undefined : await store.agents.create(OWNER, { ...materializeAgent({ model: 'm', name: 'a' }), id: agentId })
  mountSkillTools(agentCtx, {
    owner: OWNER,
    deps: { store, root, reserved: () => new Set(['create-agent']), invalidate: () => { invalidated++ } },
    agentId: () => Promise.resolve(saved?.id),
    allowHttpUrls: true,
  })
  const run = async (name: string, args: unknown) => {
    const decision = await handler!({ name, arguments: args }, () => Promise.resolve('passed'))
    const result = JSON.parse(await tools.find(t => t.name === name)!.execute(args) as string) as Record<string, unknown>
    return { decision, result }
  }
  return { store, run, tools, invalidated: () => invalidated }
}

describe('skill_create', () => {
  it('asks for approval naming the skill, then creates an active chat skill', async () => {
    const { run, store, invalidated } = await mount()
    const { decision, result } = await run('skill_create', { name: 'haiku-writer', description: 'Writes haiku', body: 'Write a haiku.', scope: 'library' })
    expect(decision).toMatchObject({ kind: 'ask' })
    expect(JSON.stringify(decision)).toContain('haiku-writer')
    expect(result).toMatchObject({ name: 'haiku-writer', status: 'active' })
    const rows = await store.skills.list(OWNER)
    expect(rows.map(r => [r.name, r.source, r.status])).toEqual([['haiku-writer', 'chat', 'active']])
    expect(invalidated()).toBe(1)
  })

  it('an invalid skill returns an error without asking', async () => {
    const { run } = await mount()
    const { decision, result } = await run('skill_create', { name: 'Bad Name', description: 'x', body: 'y', scope: 'library' })
    expect(decision).toBe('passed')
    expect(result.error).toMatch(/name/u)
  })

  it('scope agent needs a saved agent', async () => {
    const none = await mount()
    expect((await none.run('skill_create', { name: 'mine', description: 'd', body: 'b', scope: 'agent' })).result.error).toMatch(/no saved agent/u)
    const withAgent = await mount('agent_abc')
    const { result } = await withAgent.run('skill_create', { name: 'mine', description: 'd', body: 'b', scope: 'agent' })
    expect(result).toMatchObject({ name: 'mine', scope: 'agent', agent_id: 'agent_abc' })
  })
})

describe('skill_install', () => {
  it('installs a zip from a URL after approval, and refuses a bad one without asking', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/good.zip') { res.end(Buffer.from(zipSync({ 'tidy/SKILL.md': strToU8('---\nname: tidy\ndescription: Tidies\n---\nBody'), 'tidy/scripts/x.sh': strToU8('echo') }))); return }
      res.end(Buffer.from(zipSync({ 'README.md': strToU8('x') })))
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const { run } = await mount()
    const good = await run('skill_install', { url: `${base}/good.zip`, scope: 'library' })
    expect(JSON.stringify(good.decision)).toMatch(/tidy.*has scripts/u)
    expect(good.result).toMatchObject({ name: 'tidy', status: 'active', source: 'chat', has_scripts: true })
    const bad = await run('skill_install', { url: `${base}/bad.zip`, scope: 'library' })
    expect(bad.decision).toBe('passed')
    expect(bad.result.error).toMatch(/SKILL\.md not found/u)
  })

  it('needs exactly one of repo+path or url', async () => {
    const { run } = await mount()
    expect((await run('skill_install', { scope: 'library' })).result.error).toMatch(/repo and path, or url/u)
  })
})
