/** Skill install routes: upload, editor, review, activate, edit, delete, and staged expiry. */

import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { ownerId, type Principal } from '../src/auth/authenticator.ts'
import { materializeAgent } from '../src/agent-records.ts'
import { sweepStaged } from '../src/skills/install.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) })))
})

const md = (name: string, description = `${name} skill`) => `---\nname: ${name}\ndescription: ${description}\n---\n\nDo ${name}.\n`
const skillZip = (name: string, extra: Record<string, Uint8Array> = {}) => zipSync({ [`${name}/SKILL.md`]: strToU8(md(name)), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`${name}/${k}`, v])) })

/** Authenticates `x-owner` (default `test`) so a test can act as two owners. */
const twoOwners = {
  authenticate: (req: { headers: Record<string, string | string[] | undefined> }) => Promise.resolve({ ok: true, principal: { owner: ownerId(String(req.headers['x-owner'] ?? 'test')), roles: new Set(['agentry-user']) } as unknown as Principal }),
}

async function start(github?: { apiBase: string; codeloadBase: string; fetch: typeof fetch }, builtinDir = '/b') {
  const store = new MemoryStore()
  await store.ensureOwner(ownerId('test'))
  await store.ensureOwner(ownerId('other'))
  const root = await mkdtemp(join(tmpdir(), 'skill-routes-'))
  const ctx = { logger: { warn: vi.fn() }, get: () => undefined, agents: { get: () => undefined } } as unknown as Context
  const base = testGatewayOptions(createLocalProvider(join(root, 'ws')), new FakeSessionQuery())
  const options = { ...base, workspacesRoot: join(root, 'ws'), skills: () => undefined, skillsTtlMs: 0, skillsRoot: join(root, 'skills'), builtinSkills: () => [{ name: 'create-agent', description: 'Agents', dir: builtinDir }], ...(github ? { skillsGithub: github } : {}) }
  const api = new AgentsGateway(ctx, twoOwners as never, '/v1', store, new SessionRegistry(), options)
  const server = createServer((req, res) => { void api.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/skills`
  const upload = (bytes: Uint8Array, fields: Record<string, string> = { scope: 'library' }, owner = 'test') => {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), 'skill.zip')
    return fetch(url, { method: 'POST', body: form, headers: { 'x-owner': owner } })
  }
  const post = (path: string, body: unknown, owner = 'test') => fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-owner': owner } })
  const get = (path: string, owner = 'test') => fetch(`${url}${path}`, { headers: { 'x-owner': owner } })
  return { store, root, url, upload, post, get, api }
}

type Wire = { id: string; status: string; name: string; description: string; source: string; has_scripts: boolean; used_by: string[] }

describe('skill install routes', () => {
  it('upload stages for review; activate makes it visible to the default chat', async () => {
    const { upload, post, get } = await start()
    const res = await upload(skillZip('haiku', { 'scripts/run.sh': strToU8('echo hi') }))
    expect(res.status).toBe(201)
    const staged = await res.json() as Wire
    expect(staged).toMatchObject({ name: 'haiku', status: 'pending_review', source: 'upload', has_scripts: true })
    const catalog = async () => ((await (await get('')).json()) as { data: { name: string }[] }).data.map(e => e.name)
    expect(await catalog()).not.toContain('haiku')
    const manifest = await (await get(`/${staged.id}`)).json() as { files: { path: string }[]; skill_md: string }
    expect(manifest.files.map(f => f.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(manifest.skill_md).toContain('Do haiku.')
    expect((await (await post(`/${staged.id}/activate`, {})).json() as Wire).status).toBe('active')
    expect(await catalog()).toContain('haiku')
    expect(((await (await get('/installed')).json()) as { data: Wire[] }).data.map(s => s.name)).toEqual(['haiku'])
  })

  it('editor skills are active at once and editable', async () => {
    const { post } = await start()
    const created = await post('', { name: 'notes', description: 'Takes notes', body: 'Write notes.', scope: 'library' })
    expect(created.status).toBe(201)
    const row = await created.json() as Wire
    expect(row).toMatchObject({ status: 'active', source: 'editor' })
    const edited = await post(`/${row.id}`, { description: 'Takes better notes' })
    expect(edited.status).toBe(200)
    expect((await edited.json() as Wire).description).toBe('Takes better notes')
  })

  it('rejects an invalid zip, a duplicate name, and an oversize body', async () => {
    const { upload, post } = await start()
    const bad = await upload(zipSync({ 'README.md': strToU8('x') }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('skill_invalid')
    expect((await post('', { name: 'dup', description: 'd', body: 'b', scope: 'library' })).status).toBe(201)
    const dup = await post('', { name: 'dup', description: 'd', body: 'b', scope: 'library' })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('skill_name_taken')
    const big = await upload(new Uint8Array(6 * 1024 * 1024))
    expect(big.status).toBe(413)
  })

  it('another owner gets 404; a private skill needs an agent of the caller', async () => {
    const { post, get, store } = await start()
    const row = await (await post('', { name: 'mine', description: 'd', body: 'b', scope: 'library' })).json() as Wire
    expect((await get(`/${row.id}`, 'other')).status).toBe(404)
    const agent = await store.agents.create(ownerId('other'), materializeAgent({ model: 'm', name: 'theirs' }))
    expect((await post('', { name: 'priv', description: 'd', body: 'b', scope: 'agent', agent_id: agent.id })).status).toBe(404)
    const own = await store.agents.create(ownerId('test'), materializeAgent({ model: 'm', name: 'own' }))
    const priv = await post('', { name: 'priv', description: 'd', body: 'b', scope: 'agent', agent_id: own.id })
    expect(priv.status).toBe(201)
    expect((await priv.json() as Wire & { agent_id: string }).agent_id).toBe(own.id)
  })

  it('delete removes the row and the folder; used_by names selecting agents', async () => {
    const { post, get, store, root, url } = await start()
    const row = await (await post('', { name: 'gone', description: 'd', body: 'b', scope: 'library' })).json() as Wire
    await store.agents.create(ownerId('test'), materializeAgent({ model: 'm', name: 'user', skills: { builtin: [], library: [row.id] } }))
    expect((await (await get(`/${row.id}`)).json() as { skill: Wire }).skill.used_by).toHaveLength(1)
    const dir = join(root, 'skills', 'test', 'library', 'gone')
    expect(existsSync(dir)).toBe(true)
    expect((await fetch(`${url}/${row.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(existsSync(dir)).toBe(false)
    expect((await get(`/${row.id}`)).status).toBe(404)
  })

  it('sweepStaged removes skills pending for more than 24 hours, with their folders', async () => {
    const { upload, store, root } = await start()
    const old = await (await upload(skillZip('old-one'))).json() as Wire
    const fresh = await (await upload(skillZip('fresh-one'))).json() as Wire
    await store.skills.update(old.id, ownerId('test'), { updated_at: Math.floor(Date.now() / 1000) - 25 * 3600 })
    await store.skills.update(fresh.id, ownerId('test'), { updated_at: Math.floor(Date.now() / 1000) - 23 * 3600 })
    const removed = await sweepStaged({ store, root: join(root, 'skills'), reserved: () => new Set(), invalidate: () => {} }, Math.floor(Date.now() / 1000))
    expect(removed).toBe(1)
    expect(existsSync(join(root, 'skills', 'test', 'library', 'old-one'))).toBe(false)
    expect(await store.skills.get(fresh.id, ownerId('test'))).toBeDefined()
  })
})

describe('GitHub import routes', () => {
  async function fake(state: { sha: string; text: string }) {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/repos/acme/skills/commits/')) { res.writeHead(200); res.end(JSON.stringify({ sha: state.sha })); return }
      if (req.url === `/acme/skills/zip/${state.sha}`) { res.writeHead(200); res.end(Buffer.from(zipSync({ [`r-${state.sha}/s/haiku/SKILL.md`]: strToU8(state.text) }))); return }
      res.writeHead(404); res.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    return { apiBase: base, codeloadBase: base, fetch }
  }

  it('imports for review, then update keeps or re-reviews by content', async () => {
    const state = { sha: 'c0ffee1', text: md('haiku') }
    const { post } = await start(await fake(state))
    const res = await post('/import', { repo: 'acme/skills', path: 's/haiku', scope: 'library' })
    expect(res.status).toBe(201)
    const row = await res.json() as Wire & { origin: { commit: string } }
    expect(row).toMatchObject({ status: 'pending_review', source: 'github', origin: { commit: 'c0ffee1' } })
    await post(`/${row.id}/activate`, {})
    const same = await post(`/${row.id}/update`, {})
    expect(same.status).toBe(200)
    expect((await same.json() as Wire).status).toBe('active')
    state.sha = 'c0ffee2'
    state.text = md('haiku', 'Changed')
    const changed = await (await post(`/${row.id}/update`, {})).json() as Wire & { origin: { commit: string } }
    expect(changed).toMatchObject({ status: 'pending_review', description: 'Changed', origin: { commit: 'c0ffee2' } })
  })

  it('answers 502 when GitHub is unreachable and 400 for a bad repo', async () => {
    const { post } = await start({ apiBase: 'http://127.0.0.1:1', codeloadBase: 'http://127.0.0.1:1', fetch })
    const down = await post('/import', { repo: 'acme/skills', path: 's/haiku', scope: 'library' })
    expect(down.status).toBe(502)
    expect(((await down.json()) as { error: { code: string } }).error.code).toBe('skill_import_failed')
    expect((await post('/import', { repo: 'bad', path: 's', scope: 'library' })).status).toBe(400)
  })
})

describe('skill view routes', () => {
  async function builtin() {
    const dir = await mkdtemp(join(tmpdir(), 'builtin-'))
    const { mkdir, writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'SKILL.md'), md('create-agent'))
    await mkdir(join(dir, 'scripts'))
    await writeFile(join(dir, 'scripts', 'run.sh'), 'echo hi\n')
    await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
    return dir
  }

  it('views a built-in: files, SKILL.md, and one script as text', async () => {
    const { get } = await start(undefined, await builtin())
    const view = await (await get('/view/create-agent')).json() as { kind: string; files: { path: string }[]; skill_md: string }
    expect(view.kind).toBe('builtin')
    expect(view.files.map(f => f.path)).toEqual(['SKILL.md', 'logo.png', 'scripts/run.sh'])
    expect(view.skill_md).toContain('Do create-agent.')
    const file = await (await get('/view/create-agent/files/scripts/run.sh')).json() as { path: string; content: string }
    expect(file).toMatchObject({ path: 'scripts/run.sh', content: 'echo hi\n' })
  })

  it('views an installed skill by name, and refuses traversal, binaries and unknown names', async () => {
    const { post, get } = await start(undefined, await builtin())
    await post('', { name: 'notes', description: 'd', body: 'Write notes.', scope: 'library' })
    const view = await (await get('/view/notes')).json() as { kind: string; id: string }
    expect(view.kind).toBe('library')
    expect(view.id).toMatch(/^skill_/u)
    expect((await get('/view/create-agent/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(400)
    expect((await get('/view/create-agent/files/logo.png')).status).toBe(415)
    expect((await get('/view/office-docx')).status).toBe(404)
    expect((await get('/view/notes', 'other')).status).toBe(404)
  })
})
