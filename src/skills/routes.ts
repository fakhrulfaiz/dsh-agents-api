/**
 * `/agents/skills…` install routes: list installed, upload or write, review,
 * activate, edit, delete. GitHub import and update live in `github-routes.ts`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import busboy from 'busboy'
import type { OwnerId } from '../auth/authenticator.ts'
import type { Route } from '../gateway.ts'
import { json, notFound, readBody } from '../http.ts'
import { SkillNameTakenError } from '../store/store.ts'
import { activateSkill, deleteSkill, editSkill, type InstallDeps, parseTarget, replaceSkill, skillManifest, SkillTargetNotFoundError, stageSkill, toWireInstalled, usedBy } from './install.ts'
import { DEFAULT_GITHUB, fetchSkillFromGithub, SkillImportError, type GithubDeps } from './github.ts'
import { packageFromEditor, readSkillZip, SKILL_LIMITS, SkillInvalidError, SkillTooLargeError } from './package.ts'

/** Multipart framing allowance over the zip's own bytes. */
const FRAMING_BYTES = 64 * 1024

/**
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param code - error code.
 * @param message - client-facing message.
 */
function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { type: 'invalid_request_error', message, code } })
}

/**
 * Map an install error to its response; rethrow anything else.
 * @returns true when the error was answered.
 */
export function answerInstallError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof SkillInvalidError) fail(res, 400, 'skill_invalid', error.message)
  else if (error instanceof SkillNameTakenError) fail(res, 409, 'skill_name_taken', error.message)
  else if (error instanceof SkillTooLargeError) fail(res, 413, 'skill_too_large', error.message)
  else if (error instanceof SkillTargetNotFoundError) notFound(res, error.message)
  else if (error instanceof SkillImportError) json(res, 502, { error: { type: 'server_error', message: error.message, code: 'skill_import_failed' } })
  else return false
  return true
}

/** A parsed multipart upload. */
interface Upload { bytes: Uint8Array; fields: Record<string, string> }

/**
 * Read one `file` part (at most 5 MB) and the small fields.
 * @throws SkillTooLargeError over the limit; SkillInvalidError without a file part.
 */
function readUpload(req: IncomingMessage): Promise<Upload> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>
    try {
      parser = busboy({ headers: req.headers, limits: { fileSize: SKILL_LIMITS.maxBytes + 1, files: 1, fields: 4, fieldSize: 256 } })
    } catch {
      reject(new SkillInvalidError('send multipart/form-data with one "file" part'))
      return
    }
    const fields: Record<string, string> = {}
    let bytes: Uint8Array | undefined
    let tooLarge = false
    parser.on('field', (name, value) => { fields[name] = value })
    parser.on('file', (_name, stream) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('limit', () => { tooLarge = true })
      stream.on('end', () => { bytes = new Uint8Array(Buffer.concat(chunks)) })
    })
    parser.on('error', () => { reject(new SkillInvalidError('the upload could not be read')) })
    parser.on('close', () => {
      if (tooLarge) reject(new SkillTooLargeError('a skill archive may be at most 5 MB'))
      else if (bytes === undefined) reject(new SkillInvalidError('send the skill as a "file" part (.zip)'))
      else resolve({ bytes, fields })
    })
    req.pipe(parser)
  })
}

/** The install routes. */
export class SkillInstallApi {
  /**
   * @param deps - store, skills folder, reserved names, invalidation.
   * @param github - GitHub endpoints for imports.
   */
  constructor(private readonly deps: InstallDeps, private readonly github: GithubDeps = DEFAULT_GITHUB) {}

  /** @returns routes to place before `GET /agents/skills` and `/agents/:agent_id`. */
  routes(): Route[] {
    return [
      { method: 'GET', pattern: '/agents/skills/installed', handler: (_req, res, url, _params, p) => this.list(res, url, p.owner) },
      { method: 'POST', pattern: '/agents/skills', handler: (req, res, _url, _params, p) => this.create(req, res, p.owner) },
      { method: 'POST', pattern: '/agents/skills/import', handler: (req, res, _url, _params, p) => this.importSkill(req, res, p.owner) },
      { method: 'POST', pattern: '/agents/skills/:skill_id/update', handler: (_req, res, _url, params, p) => this.update(res, params['skill_id'] ?? '', p.owner) },
      { method: 'GET', pattern: '/agents/skills/:skill_id', handler: (_req, res, _url, params, p) => this.get(res, params['skill_id'] ?? '', p.owner) },
      { method: 'POST', pattern: '/agents/skills/:skill_id/activate', handler: (_req, res, _url, params, p) => this.activate(res, params['skill_id'] ?? '', p.owner) },
      { method: 'POST', pattern: '/agents/skills/:skill_id', handler: (req, res, _url, params, p) => this.edit(req, res, params['skill_id'] ?? '', p.owner) },
      { method: 'DELETE', pattern: '/agents/skills/:skill_id', handler: (_req, res, _url, params, p) => this.remove(res, params['skill_id'] ?? '', p.owner) },
    ]
  }

  private async list(res: ServerResponse, url: URL, owner: OwnerId): Promise<void> {
    const scope = url.searchParams.get('scope') ?? undefined
    const agentId = url.searchParams.get('agent_id') ?? undefined
    if (scope !== undefined && scope !== 'library' && scope !== 'agent') {
      fail(res, 400, 'bad_request', 'scope must be "library" or "agent"')
      return
    }
    const rows = await this.deps.store.skills.list(owner, { ...(scope ? { scope } : {}), ...(agentId ? { agentId } : {}) })
    const data = await Promise.all(rows.map(async row => toWireInstalled(row, await usedBy(this.deps.store, owner, row))))
    json(res, 200, { object: 'list', data })
  }

  private async create(req: IncomingMessage, res: ServerResponse, owner: OwnerId): Promise<void> {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > SKILL_LIMITS.maxBytes + FRAMING_BYTES) {
      fail(res, 413, 'skill_too_large', 'a skill may be at most 5 MB')
      req.resume()
      return
    }
    try {
      if (/^multipart\/form-data/iu.test(req.headers['content-type'] ?? '')) {
        const upload = await readUpload(req)
        const target = parseTarget(upload.fields)
        if (typeof target === 'string') { fail(res, 400, 'bad_request', target); return }
        const row = await stageSkill(this.deps, owner, readSkillZip(upload.bytes, this.deps.reserved()), target, 'upload')
        json(res, 201, toWireInstalled(row, await usedBy(this.deps.store, owner, row)))
        return
      }
      const body = await readBody(req)
      const target = parseTarget(body)
      if (typeof target === 'string') { fail(res, 400, 'bad_request', target); return }
      const text = (key: string) => (typeof body[key] === 'string' ? body[key] : '')
      const pkg = packageFromEditor({ name: text('name'), description: text('description'), body: text('body') }, this.deps.reserved())
      const row = await stageSkill(this.deps, owner, pkg, target, 'editor', null, 'active')
      json(res, 201, toWireInstalled(row, await usedBy(this.deps.store, owner, row)))
    } catch (error: unknown) {
      if (!answerInstallError(res, error)) throw error
    }
  }

  private async importSkill(req: IncomingMessage, res: ServerResponse, owner: OwnerId): Promise<void> {
    const body = await readBody(req)
    const target = parseTarget(body)
    if (typeof target === 'string') { fail(res, 400, 'bad_request', target); return }
    if (typeof body['repo'] !== 'string' || typeof body['path'] !== 'string') { fail(res, 400, 'bad_request', 'repo and path are required'); return }
    try {
      const { pkg, origin } = await fetchSkillFromGithub(this.github, { repo: body['repo'], path: body['path'], ...(typeof body['ref'] === 'string' ? { ref: body['ref'] } : {}) }, this.deps.reserved())
      const row = await stageSkill(this.deps, owner, pkg, target, 'github', origin)
      json(res, 201, toWireInstalled(row, await usedBy(this.deps.store, owner, row)))
    } catch (error: unknown) {
      if (!answerInstallError(res, error)) throw error
    }
  }

  private async update(res: ServerResponse, id: string, owner: OwnerId): Promise<void> {
    const row = await this.deps.store.skills.get(id, owner)
    if (row === undefined) { notFound(res, `Skill "${id}" not found`); return }
    if (row.source !== 'github' || row.origin === null) { fail(res, 400, 'skill_invalid', 'only skills imported from GitHub can be updated'); return }
    try {
      const { pkg, origin } = await fetchSkillFromGithub(this.github, { repo: row.origin.repo, path: row.origin.path, ref: row.origin.ref }, this.deps.reserved())
      const updated = pkg.contentHash === row.content_hash ? row : await replaceSkill(this.deps, owner, row, pkg, origin, 'pending_review')
      json(res, 200, toWireInstalled(updated ?? row, await usedBy(this.deps.store, owner, updated ?? row)))
    } catch (error: unknown) {
      if (!answerInstallError(res, error)) throw error
    }
  }

  private async get(res: ServerResponse, id: string, owner: OwnerId): Promise<void> {
    const row = await this.deps.store.skills.get(id, owner)
    if (row === undefined) { notFound(res, `Skill "${id}" not found`); return }
    json(res, 200, await skillManifest(this.deps, row))
  }

  private async activate(res: ServerResponse, id: string, owner: OwnerId): Promise<void> {
    const row = await activateSkill(this.deps, owner, id)
    if (row === undefined) { notFound(res, `Skill "${id}" not found`); return }
    json(res, 200, toWireInstalled(row, await usedBy(this.deps.store, owner, row)))
  }

  private async edit(req: IncomingMessage, res: ServerResponse, id: string, owner: OwnerId): Promise<void> {
    const body = await readBody(req)
    const input = {
      ...(typeof body['description'] === 'string' ? { description: body['description'] } : {}),
      ...(typeof body['body'] === 'string' ? { body: body['body'] } : {}),
    }
    try {
      const row = await editSkill(this.deps, owner, id, input)
      if (row === undefined) { notFound(res, `Skill "${id}" not found`); return }
      json(res, 200, toWireInstalled(row, await usedBy(this.deps.store, owner, row)))
    } catch (error: unknown) {
      if (!answerInstallError(res, error)) throw error
    }
  }

  private async remove(res: ServerResponse, id: string, owner: OwnerId): Promise<void> {
    if (!await deleteSkill(this.deps, owner, id)) { notFound(res, `Skill "${id}" not found`); return }
    json(res, 200, { id, object: 'agent.skill.deleted', deleted: true })
  }
}
