/** Skill import from GitHub: commit pinning, path selection, update, failures. */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchSkillFromGithub, SkillImportError } from '../src/skills/github.ts'
import { SkillInvalidError } from '../src/skills/package.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) })))
})

const md = (name: string, description = `${name} skill`) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`

/** A fake api.github.com + codeload.github.com on one port. */
async function fakeGithub(state: { sha: string; zip: () => Uint8Array }) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/repos/acme/skills/commits/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sha: state.sha }))
    } else if (req.url === `/acme/skills/zip/${state.sha}`) {
      res.writeHead(200, { 'content-type': 'application/zip' })
      res.end(Buffer.from(state.zip()))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { apiBase: base, codeloadBase: base, fetch }
}

const repoZip = (sha: string, files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([p, t]) => [`skills-${sha}/${p}`, strToU8(t)])))

describe('fetchSkillFromGithub', () => {
  it('pins the commit and keeps only the files under the path', async () => {
    const deps = await fakeGithub({ sha: 'abc123', zip: () => repoZip('abc123', { 'skills/haiku/SKILL.md': md('haiku'), 'skills/haiku/ref.md': 'r', 'skills/other/SKILL.md': md('other'), 'README.md': 'x' }) })
    const { pkg, origin } = await fetchSkillFromGithub(deps, { repo: 'acme/skills', path: '/skills/haiku/' }, new Set())
    expect(origin).toEqual({ repo: 'acme/skills', path: 'skills/haiku', ref: 'HEAD', commit: 'abc123' })
    expect(pkg.name).toBe('haiku')
    expect(pkg.files.map(f => f.path)).toEqual(['SKILL.md', 'ref.md'])
  })

  it('a folder without SKILL.md is skill_invalid, not an import failure', async () => {
    const deps = await fakeGithub({ sha: 'a1b1', zip: () => repoZip('a1b1', { 'docs/readme.md': 'x', 'skills/haiku/SKILL.md': md('haiku') }) })
    await expect(fetchSkillFromGithub(deps, { repo: 'acme/skills', path: 'docs' }, new Set())).rejects.toThrow(SkillInvalidError)
    await expect(fetchSkillFromGithub(deps, { repo: 'acme/skills', path: 'docs' }, new Set())).rejects.toThrow(/SKILL\.md not found/u)
    await expect(fetchSkillFromGithub(deps, { repo: 'acme/skills', path: 'skills/haiku/SKILL.md' }, new Set())).rejects.toThrow(/SKILL\.md not found/u)
  })

  it('an unreachable host or unknown repo is SkillImportError', async () => {
    const deps = await fakeGithub({ sha: 'a1b1', zip: () => new Uint8Array() })
    await expect(fetchSkillFromGithub(deps, { repo: 'acme/missing', path: 'x' }, new Set())).rejects.toThrow(SkillImportError)
    await expect(fetchSkillFromGithub({ ...deps, apiBase: 'http://127.0.0.1:1' }, { repo: 'acme/skills', path: 'x' }, new Set())).rejects.toThrow(SkillImportError)
  })

  it('rejects a malformed repo or a parent path', async () => {
    const deps = await fakeGithub({ sha: 'a1b1', zip: () => new Uint8Array() })
    await expect(fetchSkillFromGithub(deps, { repo: 'not a repo', path: 'x' }, new Set())).rejects.toThrow(SkillInvalidError)
    await expect(fetchSkillFromGithub(deps, { repo: 'acme/skills', path: '../x' }, new Set())).rejects.toThrow(SkillInvalidError)
  })
})
