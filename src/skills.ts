/**
 * `GET /v1/agents/skills`: the Host skill catalog for the `/` picker.
 *
 * The Host `skills` service layers skills by agent scope and workspace, so a
 * request resolves to a (scope, cwd) target: the live agent and workspace of
 * `?session_id=` (owned by the caller), else the default preset's scope and
 * the owner's default workspace root. The catalog is read at request time,
 * cached in memory per target for a configured TTL, and served with a strong
 * `ETag` so clients revalidate cheaply.
 */

import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { SkillSummary, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { OwnerId } from './auth/authenticator.ts'
import type { Route } from './gateway.ts'
import { errorMessage, json, notFound } from './http.ts'
import type { AgentSkill } from './types.ts'

/** The registry view one catalog request reads. */
export interface SkillTarget {
  /** Agent scope key whose layers are visible; `undefined` reads the global layer alone. */
  scope: SkillViewOptions['scope']
  /** Workspace whose `.agents/skills` is included; `undefined` omits project skills. */
  cwd: string | undefined
  /** Releases a lease held on `scope`; called once the request finished reading. */
  release?: () => PromiseLike<void>
}

/** What `SkillsApi` needs from the gateway. */
export interface SkillsApiDeps {
  /** The Host skill registry, read at call time; `undefined` answers an empty list. */
  skills: () => { list: (options?: SkillViewOptions) => Promise<readonly SkillSummary[]> } | undefined
  /**
   * Resolve the registry view of a request.
   * @param owner - authenticated caller.
   * @param sessionId - `session_id` query value, when given.
   * @returns the target, or `undefined` when `sessionId` is not a session of `owner`.
   */
  resolveTarget: (owner: OwnerId, sessionId: string | undefined) => Promise<SkillTarget | undefined>
  /** Milliseconds a loaded catalog is served without calling `list()` again; 0 disables the cache. */
  ttlMs: number
  /** Report a failed `list()`; the response carries a generic message. */
  warn: (message: string) => void
  /** Clock in epoch milliseconds, injectable in tests. */
  now?: () => number
}

/** `Cache-Control` of every catalog response: clients always revalidate with `If-None-Match`. */
const CACHE_CONTROL = 'private, max-age=0, must-revalidate'

/** A serialized catalog and its validator. */
interface Loaded {
  body: string
  etag: string
}

/**
 * Wire form of a skill summary.
 * @param skill - summary from the Host registry.
 * @returns the catalog entry.
 */
export function toWireSkill(skill: SkillSummary): AgentSkill {
  return { name: skill.name, description: skill.description, source: skill.source }
}

/**
 * Whether an `If-None-Match` header names `etag`, using weak comparison (RFC 9110 section 13.1.2).
 * @param header - raw header value.
 * @param etag - strong entity tag of the current body.
 * @returns true when the header is `*` or lists the tag.
 */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  return header.split(',').some((candidate) => {
    const tag = candidate.trim()
    return tag === '*' || tag.replace(/^W\//u, '') === etag
  })
}

/** The skill catalog route and its per-target cache. */
export class SkillsApi {
  /** Cached catalogs by scope, then cwd (`''` for no cwd). */
  readonly #loaded = new Map<unknown, Map<string, Loaded & { expiresAt: number }>>()
  readonly #inflight = new Map<unknown, Map<string, Promise<Loaded>>>()

  /** @param deps - service accessor, target resolver, cache TTL, and logger. */
  constructor(private readonly deps: SkillsApiDeps) {}

  /** @returns the catalog route, to be placed before `/agents/:agent_id`. */
  routes(): Route[] {
    return [
      {
        method: 'GET',
        pattern: '/agents/skills',
        handler: (req, res, url, _params, principal) => this.list(res, principal.owner, url.searchParams.get('session_id') ?? undefined, req.headers['if-none-match']),
      },
    ]
  }

  /**
   * Answer the catalog, a 304 for a matching validator, 404 for a session the caller does not own, or 503 when loading fails.
   * @param res - outgoing response.
   * @param owner - authenticated caller.
   * @param sessionId - `session_id` query value.
   * @param ifNoneMatch - request `If-None-Match` value.
   */
  private async list(res: ServerResponse, owner: OwnerId, sessionId: string | undefined, ifNoneMatch: string | undefined): Promise<void> {
    let loaded: Loaded
    try {
      const target = await this.deps.resolveTarget(owner, sessionId)
      if (target === undefined) {
        notFound(res, `Session "${sessionId ?? ''}" not found`)
        return
      }
      try {
        loaded = await this.load(target)
      } finally {
        await target.release?.()
      }
    } catch (error: unknown) {
      this.deps.warn(`agents-api: skill catalog failed to load: ${errorMessage(error)}`)
      json(res, 503, { error: { type: 'server_error', message: 'The skill catalog could not be loaded', code: 'skills_unavailable' } })
      return
    }
    const headers = { ETag: loaded.etag, 'Cache-Control': CACHE_CONTROL }
    if (matchesEtag(ifNoneMatch, loaded.etag)) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loaded.body) })
    res.end(loaded.body)
  }

  /**
   * The serialized catalog of one target: cached while fresh, otherwise one shared `list()` call per (scope, cwd).
   * Failures are not cached.
   * @param target - registry view to read.
   * @returns the body and its entity tag.
   */
  private load(target: SkillTarget): Promise<Loaded> {
    const now = this.deps.now ?? Date.now
    const cwdKey = target.cwd ?? ''
    const cached = this.#loaded.get(target.scope)?.get(cwdKey)
    if (cached !== undefined && now() < cached.expiresAt) return Promise.resolve(cached)
    const service = this.deps.skills()
    if (service === undefined) return Promise.resolve(serialize([]))
    const flights = this.#inflight.get(target.scope) ?? new Map<string, Promise<Loaded>>()
    this.#inflight.set(target.scope, flights)
    const shared = flights.get(cwdKey)
    if (shared !== undefined) return shared
    const flight = service.list({ scope: target.scope, cwd: target.cwd })
      .then((summaries) => {
        const loaded = serialize(summaries.map(toWireSkill))
        if (this.deps.ttlMs > 0) this.store(target.scope, cwdKey, { ...loaded, expiresAt: now() + this.deps.ttlMs })
        return loaded
      })
      .finally(() => {
        flights.delete(cwdKey)
        if (flights.size === 0) this.#inflight.delete(target.scope)
      })
    flights.set(cwdKey, flight)
    return flight
  }

  /**
   * Cache a catalog and drop expired entries, so per-session scopes do not accumulate.
   * @param scope - scope key of the entry.
   * @param cwdKey - cwd component of the key.
   * @param entry - catalog with its expiry.
   */
  private store(scope: unknown, cwdKey: string, entry: Loaded & { expiresAt: number }): void {
    const now = (this.deps.now ?? Date.now)()
    for (const [key, byCwd] of this.#loaded) {
      for (const [cwd, old] of byCwd) if (now >= old.expiresAt) byCwd.delete(cwd)
      if (byCwd.size === 0) this.#loaded.delete(key)
    }
    const byCwd = this.#loaded.get(scope) ?? new Map()
    this.#loaded.set(scope, byCwd)
    byCwd.set(cwdKey, entry)
  }
}

/**
 * Sort entries by name and serialize them with a strong entity tag.
 * @param entries - catalog entries.
 * @returns the JSON body and `"sha256-<hex>"` tag.
 */
function serialize(entries: AgentSkill[]): Loaded {
  const data = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const body = JSON.stringify({ object: 'list', data })
  return { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` }
}
