/**
 * Import a skill folder from a public GitHub repository: resolve the ref to a
 * commit, download that commit's zipball, keep the files under the path.
 */

import type { SkillOrigin } from '../store/store.ts'
import { packageFromFiles, readSkillZip, SkillInvalidError, type SkillFile, type SkillPackage } from './package.ts'
import { strFromU8, unzipSync } from 'fflate'

/** Where GitHub is; injectable for tests. */
export interface GithubDeps {
  /** Default `https://api.github.com`. */
  apiBase: string
  /** Default `https://codeload.github.com`. */
  codeloadBase: string
  fetch: typeof fetch
}

export const DEFAULT_GITHUB: GithubDeps = { apiBase: 'https://api.github.com', codeloadBase: 'https://codeload.github.com', fetch: (...args) => fetch(...args) }

/** GitHub could not be reached, or did not have the repository or ref. */
export class SkillImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillImportError'
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const TIMEOUT_MS = 30_000
/** A repository zipball may be large; only the skill folder inside it is kept (and that must fit 5 MB). */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

/**
 * @param deps - GitHub endpoints.
 * @param repo - `owner/name`.
 * @param ref - branch, tag or sha; `HEAD` for the default branch.
 * @returns the commit sha.
 */
export async function resolveCommit(deps: GithubDeps, repo: string, ref: string): Promise<string> {
  let res: Response
  try {
    res = await deps.fetch(`${deps.apiBase}/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentry-api' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new SkillImportError('GitHub could not be reached')
  }
  if (!res.ok) throw new SkillImportError(`GitHub has no commit "${ref}" in ${repo} (HTTP ${String(res.status)})`)
  const sha = ((await res.json().catch(() => ({}))) as { sha?: unknown }).sha
  if (typeof sha !== 'string' || !/^[a-f0-9]{4,64}$/u.test(sha)) throw new SkillImportError('GitHub answered without a commit sha')
  return sha
}

/**
 * @param deps - GitHub endpoints.
 * @param input - `repo` (`owner/name`), `path` to the skill folder, optional `ref`.
 * @param reserved - built-in names.
 * @returns the validated package and its pinned origin.
 * @throws SkillInvalidError for bad input or a folder that is not a skill; SkillImportError when GitHub fails.
 */
export async function fetchSkillFromGithub(deps: GithubDeps, input: { repo: string; path: string; ref?: string }, reserved: ReadonlySet<string>): Promise<{ pkg: SkillPackage; origin: SkillOrigin }> {
  if (!REPO.test(input.repo)) throw new SkillInvalidError('repo must look like "owner/name"')
  const path = input.path.replace(/^\/+|\/+$/gu, '')
  if (path.split('/').some(s => s === '..' || s === '.')) throw new SkillInvalidError('path may not contain "." or ".." segments')
  const ref = input.ref?.trim() || 'HEAD'
  const commit = await resolveCommit(deps, input.repo, ref)
  let bytes: Uint8Array
  try {
    const res = await deps.fetch(`${deps.codeloadBase}/${input.repo}/zip/${commit}`, { headers: { 'User-Agent': 'agentry-api' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new SkillImportError(`GitHub did not send the archive (HTTP ${String(res.status)})`)
    const length = Number(res.headers.get('content-length') ?? 0)
    if (length > MAX_DOWNLOAD_BYTES) throw new SkillImportError('the repository archive is larger than 50 MB')
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (error: unknown) {
    if (error instanceof SkillImportError) throw error
    throw new SkillImportError('GitHub could not be reached')
  }
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new SkillImportError('the repository archive is larger than 50 MB')
  // Only entries under `<top>/<path>/` are inflated; the folder then gets the same checks as an upload.
  let top: string | undefined
  let wanted: Record<string, Uint8Array>
  try {
    wanted = unzipSync(bytes, {
      filter: (file) => {
        top ??= file.name.split('/')[0]
        return path === '' ? false : file.name.startsWith(`${top}/${path}/`) && !file.name.endsWith('/')
      },
    })
  } catch {
    throw new SkillImportError('the repository archive could not be read')
  }
  const prefix = `${top ?? ''}/${path}/`
  const files: SkillFile[] = Object.entries(wanted).map(([name, data]) => ({ path: name.slice(prefix.length), bytes: data }))
  if (!files.some(f => f.path === 'SKILL.md')) throw new SkillInvalidError(`SKILL.md not found in ${input.repo}/${path}`)
  const leaf = path.split('/').at(-1)
  return { pkg: packageFromFiles(files, reserved, leaf), origin: { repo: input.repo, path, ref, commit } }
}

/** Kept for callers that import zips by URL (chat `skill_install`). */
export { readSkillZip, strFromU8 }
