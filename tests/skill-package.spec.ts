/** Skill package validation: zip, file list and editor input into one `SkillPackage`. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { packageFromEditor, packageFromFiles, readSkillZip, SKILL_LIMITS, SkillInvalidError, SkillTooLargeError } from '../src/skills/package.ts'
import { removeSkill, skillDir, writeSkill } from '../src/skills/disk.ts'
import { ownerId } from '../src/auth/authenticator.ts'

const NONE = new Set<string>()
const md = (name: string, description = 'Writes haiku.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`
const zip = (files: Zippable) => zipSync(files)

describe('readSkillZip', () => {
  it('reads a valid zip, stripping one top folder', () => {
    const pkg = readSkillZip(zip({ 'haiku/SKILL.md': strToU8(md('haiku')), 'haiku/references/a.md': strToU8('ref') }), NONE)
    expect(pkg.name).toBe('haiku')
    expect(pkg.description).toBe('Writes haiku.')
    expect(pkg.files.map(f => f.path).sort()).toEqual(['SKILL.md', 'references/a.md'])
    expect(pkg.hasScripts).toBe(false)
    expect(pkg.contentHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('flags scripts', () => {
    expect(readSkillZip(zip({ 'SKILL.md': strToU8(md('runner')), 'scripts/run.sh': strToU8('echo') }), NONE).hasScripts).toBe(true)
  })

  it('skips __MACOSX and directory entries', () => {
    const pkg = readSkillZip(zip({ 'SKILL.md': strToU8(md('mac')), '__MACOSX/._SKILL.md': strToU8('x'), 'docs/': {} as never }), NONE)
    expect(pkg.files.map(f => f.path)).toEqual(['SKILL.md'])
  })

  const invalid: Array<[string, Zippable, RegExp]> = [
    ['missing SKILL.md', { 'README.md': strToU8('x') }, /SKILL\.md not found/u],
    ['a parent path', { 'SKILL.md': strToU8(md('a')), '../evil': strToU8('x') }, /path/u],
    ['an absolute path', { 'SKILL.md': strToU8(md('a')), '/etc/passwd': strToU8('x') }, /path/u],
    ['a hidden folder', { 'SKILL.md': strToU8(md('a')), '.ssh/x': strToU8('x') }, /hidden/u],
    ['a bad name', { 'SKILL.md': strToU8(md('Bad_Name')) }, /name/u],
    ['a long description', { 'SKILL.md': strToU8(md('a', 'x'.repeat(1025))) }, /description/u],
    ['a folder name that differs from the frontmatter name', { 'haiku/SKILL.md': strToU8(md('other')) }, /name/u],
  ]
  for (const [label, files, message] of invalid) {
    it(`rejects ${label}`, () => {
      expect(() => readSkillZip(zip(files), NONE)).toThrow(SkillInvalidError)
      expect(() => readSkillZip(zip(files), NONE)).toThrow(message)
    })
  }

  it('rejects a symlink entry', () => {
    const files: Zippable = { 'SKILL.md': strToU8(md('a')), link: [strToU8('/etc'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }
    expect(() => readSkillZip(zip(files), NONE)).toThrow(/symlink/u)
  })

  it('rejects a reserved built-in name', () => {
    expect(() => readSkillZip(zip({ 'SKILL.md': strToU8(md('create-agent')) }), new Set(['create-agent']))).toThrow(/reserved/u)
  })

  it('rejects more than 200 files', () => {
    const files: Zippable = { 'SKILL.md': strToU8(md('many')) }
    for (let i = 0; i < SKILL_LIMITS.maxFiles; i++) files[`f/${String(i)}.txt`] = strToU8('x')
    expect(() => readSkillZip(zip(files), NONE)).toThrow(SkillTooLargeError)
  })

  it('rejects a declared size over 5 MB', () => {
    const big = new Uint8Array(SKILL_LIMITS.maxBytes + 1).map((_, i) => (i * 7919) % 251)
    expect(() => readSkillZip(zip({ 'SKILL.md': strToU8(md('big')), 'blob.bin': [big, { level: 0 }] }), NONE)).toThrow(SkillTooLargeError)
  })

  it('rejects a compression-ratio bomb', () => {
    expect(() => readSkillZip(zip({ 'SKILL.md': strToU8(md('bomb')), 'zeros.txt': new Uint8Array(1024 * 1024) }), NONE)).toThrow(SkillTooLargeError)
  })

  it('rejects bytes that are not a zip', () => {
    expect(() => readSkillZip(strToU8('not a zip'), NONE)).toThrow(SkillInvalidError)
  })
})

describe('packageFromFiles', () => {
  it('checks the expected folder name', () => {
    const files = [{ path: 'SKILL.md', bytes: strToU8(md('one')) }]
    expect(packageFromFiles(files, NONE, 'one').name).toBe('one')
    expect(() => packageFromFiles(files, NONE, 'two')).toThrow(/name/u)
  })
})

describe('packageFromEditor', () => {
  it('produces exactly one SKILL.md whose frontmatter round-trips', () => {
    const pkg = packageFromEditor({ name: 'notes', description: 'Takes notes: briefly', body: '# Notes\n\nWrite notes.' }, NONE)
    expect(pkg.files.map(f => f.path)).toEqual(['SKILL.md'])
    const again = packageFromFiles(pkg.files, NONE)
    expect(again.name).toBe('notes')
    expect(again.description).toBe('Takes notes: briefly')
    expect(again.skillMd).toContain('Write notes.')
  })
})

describe('skill folders on disk', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))) })

  it('lays out library and private skills', () => {
    const owner = ownerId('dev')
    expect(skillDir('/data', { owner, scope: 'library', agent_id: null, name: 'a' })).toBe('/data/dev/library/a')
    expect(skillDir('/data', { owner, scope: 'agent', agent_id: 'agent_1', name: 'a' })).toBe('/data/dev/agents/agent_1/a')
  })

  it('writes then removes a skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-'))
    roots.push(root)
    const pkg = packageFromEditor({ name: 'disk', description: 'd', body: 'b' }, NONE)
    const dir = join(root, 'dev', 'library', 'disk')
    await writeSkill(dir, pkg)
    expect(await readFile(join(dir, 'SKILL.md'))).toEqual(Buffer.from(pkg.files[0]!.bytes))
    await removeSkill(dir)
    await expect(readFile(join(dir, 'SKILL.md'))).rejects.toThrow()
  })
})
