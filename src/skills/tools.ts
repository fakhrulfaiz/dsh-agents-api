/**
 * Model-facing skill tools: `skill_create` (write a skill) and `skill_install`
 * (from GitHub or a .zip URL). Both are prepared and validated before the user
 * is asked; the approval card shows the manifest, and approving activates it.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OwnerId } from '../auth/authenticator.ts'
import { DEFAULT_GITHUB, fetchSkillFromGithub, SkillImportError, type GithubDeps } from './github.ts'
import { type InstallDeps, stageSkill, SkillTargetNotFoundError, toWireInstalled } from './install.ts'
import { packageFromEditor, readSkillZip, SKILL_LIMITS, SkillInvalidError, SkillTooLargeError, type SkillPackage } from './package.ts'
import { SkillNameTakenError, type SkillOrigin, type SkillScope } from '../store/store.ts'

export const SKILL_TOOL_NAMES = ['skill_create', 'skill_install'] as const

/** What the skill tools need. */
export interface SkillToolsDeps {
  owner: OwnerId
  deps: InstallDeps
  /** The session's saved agent id, or `undefined` in the default chat. */
  agentId: () => Promise<string | undefined>
  github?: GithubDeps
  /** Allow `http:` zip URLs (tests only). */
  allowHttpUrls?: boolean
}

type Args = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/** A prepared install: the validated package and where it goes. */
interface Prepared { pkg: SkillPackage; scope: SkillScope; agentId?: string; origin: SkillOrigin | null }

const SCOPE = { type: 'string', enum: ['library', 'agent'], description: 'library: all of the user\'s agents can use it; agent: only this chat\'s saved agent.' }

const DEFINITIONS = {
  skill_create: {
    description: 'Write a new skill (a SKILL.md with instructions) and install it. The user is asked to approve it. Use when the user asks you to make or save a skill.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case, at most 64 characters' },
        description: { type: 'string', maxLength: SKILL_LIMITS.descriptionMax, description: 'When to use the skill, in one or two sentences.' },
        body: { type: 'string', description: 'The skill instructions in Markdown.' },
        scope: SCOPE,
      },
      required: ['name', 'description', 'body'],
      additionalProperties: false,
    },
  },
  skill_install: {
    description: 'Install a skill from a public GitHub folder (repo + path) or a .zip URL. The user is asked to approve it after seeing its files.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub "owner/name"' },
        path: { type: 'string', description: 'Folder in the repository that holds SKILL.md' },
        ref: { type: 'string', description: 'Branch, tag or commit; default branch when absent' },
        url: { type: 'string', description: 'https URL of a .zip holding one skill' },
        scope: SCOPE,
      },
      additionalProperties: false,
    },
  },
} as const

/**
 * Download a skill zip.
 * @throws SkillInvalidError for a disallowed URL; SkillImportError when the download fails; SkillTooLargeError over 5 MB.
 */
async function fetchZip(url: string, allowHttp: boolean): Promise<Uint8Array> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SkillInvalidError('url is not a valid URL')
  }
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) throw new SkillInvalidError('url must be an https URL')
  let res: Response
  try {
    res = await fetch(parsed, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
  } catch {
    throw new SkillImportError('the zip could not be downloaded')
  }
  if (!res.ok) throw new SkillImportError(`the zip download answered HTTP ${String(res.status)}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > SKILL_LIMITS.maxBytes) throw new SkillTooLargeError('a skill archive may be at most 5 MB')
  return bytes
}

/** @returns a message the model can act on for an install error; rethrows unknown errors. */
function errorText(error: unknown): string {
  if (error instanceof SkillInvalidError || error instanceof SkillTooLargeError || error instanceof SkillImportError || error instanceof SkillNameTakenError || error instanceof SkillTargetNotFoundError) return error.message
  throw error
}

/**
 * Register `skill_create` and `skill_install` and their approval handler on an agent scope.
 * @param agentCtx - agent-scoped context.
 * @param tools - owner, install deps, and the session's saved agent.
 */
export function mountSkillTools(agentCtx: Context, tools: SkillToolsDeps): void {
  const reserved = () => tools.deps.reserved()
  const prepared = new Map<string, Prepared | { error: string }>()
  const key = (name: string, args: unknown) => `${name}:${JSON.stringify(args ?? {})}`

  const prepare = async (name: string, args: Args): Promise<Prepared | { error: string }> => {
    const cached = prepared.get(key(name, args))
    if (cached !== undefined) return cached
    let result: Prepared | { error: string }
    try {
      const scope: SkillScope = args.scope === 'agent' ? 'agent' : 'library'
      const agentId = scope === 'agent' ? await tools.agentId() : undefined
      if (scope === 'agent' && agentId === undefined) return { error: 'this chat has no saved agent; use scope "library"' }
      let pkg: SkillPackage
      let origin: SkillOrigin | null = null
      if (name === 'skill_create') {
        pkg = packageFromEditor({ name: str(args.name) ?? '', description: str(args.description) ?? '', body: str(args.body) ?? '' }, reserved())
      } else {
        const repo = str(args.repo)
        const path = str(args.path)
        const url = str(args.url)
        if ((repo !== undefined && path !== undefined) === (url !== undefined)) return { error: 'give either repo and path, or url' }
        if (url !== undefined) {
          pkg = readSkillZip(await fetchZip(url, tools.allowHttpUrls === true), reserved())
        } else {
          const ref = str(args.ref)
          const imported = await fetchSkillFromGithub(tools.github ?? DEFAULT_GITHUB, { repo: repo!, path: path!, ...(ref ? { ref } : {}) }, reserved())
          pkg = imported.pkg
          origin = imported.origin
        }
      }
      result = { pkg, scope, ...(agentId ? { agentId } : {}), origin }
    } catch (error: unknown) {
      result = { error: errorText(error) }
    }
    prepared.set(key(name, args), result)
    return result
  }

  for (const name of SKILL_TOOL_NAMES) {
    const definition = DEFINITIONS[name]
    agentCtx.tools.register({
      name,
      description: definition.description,
      parameters: definition.parameters,
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      async execute(args: unknown) {
        const ready = await prepare(name, (args ?? {}) as Args)
        prepared.delete(key(name, args))
        if ('error' in ready) return JSON.stringify(ready)
        try {
          const target = ready.scope === 'agent' ? { scope: 'agent' as const, agentId: ready.agentId! } : { scope: 'library' as const }
          const row = await stageSkill(tools.deps, tools.owner, ready.pkg, target, 'chat', ready.origin, 'active')
          return JSON.stringify(toWireInstalled(row, ready.scope === 'agent' ? [ready.agentId!] : []))
        } catch (error: unknown) {
          return JSON.stringify({ error: errorText(error) })
        }
      },
    } as ToolDefinition)
  }

  if (typeof (agentCtx as { on?: unknown }).on !== 'function') return
  const approve = async (exec: { name: string; arguments: unknown }, next: () => Promise<unknown>): Promise<unknown> => {
    if (!(SKILL_TOOL_NAMES as readonly string[]).includes(exec.name)) return next()
    const ready = await prepare(exec.name, (exec.arguments ?? {}) as Args)
    if ('error' in ready) return next()
    const { pkg } = ready
    const text = `Install skill "${pkg.name}" (${String(pkg.files.length)} file${pkg.files.length === 1 ? '' : 's'}${pkg.hasScripts ? ', has scripts' : ''}): ${pkg.description.slice(0, 160)}`
    return { kind: 'ask' as const, reason: text, displayReason: { en: text } }
  }
  agentCtx.on('tools/pre-execute', approve as never)
}
