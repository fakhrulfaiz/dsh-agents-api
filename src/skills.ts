/**
 * `GET /v1/agents/skills`: the Host skill catalog for the `/` picker.
 *
 * The catalog is host-wide (not owner-scoped). It is read from the Host
 * `skills` service at request time, cached in memory for a configured TTL,
 * and served with a strong `ETag` so clients revalidate cheaply.
 */

import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type { Route } from './gateway.ts'
import { errorMessage, json } from './http.ts'
import type { AgentSkill } from './types.ts'

/** What `SkillsApi` needs from the gateway. */
export interface SkillsApiDeps {
  /** The Host skill registry, read at call time; `undefined` answers an empty list. */
  skills: () => { list: () => Promise<readonly SkillSummary[]> } | undefined
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

/** The skill catalog route and its cache. */
export class SkillsApi {
  #loaded: (Loaded & { expiresAt: number }) | undefined
  #inflight: Promise<Loaded> | undefined

  /** @param deps - service accessor, cache TTL, and logger. */
  constructor(private readonly deps: SkillsApiDeps) {}

  /** @returns the catalog route, to be placed before `/agents/:agent_id`. */
  routes(): Route[] {
    return [
      { method: 'GET', pattern: '/agents/skills', handler: (req, res) => this.list(res, req.headers['if-none-match']) },
    ]
  }

  /**
   * Answer the catalog, a 304 for a matching validator, or 503 when loading fails.
   * @param res - outgoing response.
   * @param ifNoneMatch - request `If-None-Match` value.
   */
  private async list(res: ServerResponse, ifNoneMatch: string | undefined): Promise<void> {
    let loaded: Loaded
    try {
      loaded = await this.load()
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
   * The serialized catalog: cached while fresh, otherwise one shared `list()` call.
   * Failures are not cached.
   * @returns the body and its entity tag.
   */
  private load(): Promise<Loaded> {
    const now = this.deps.now ?? Date.now
    if (this.#loaded !== undefined && now() < this.#loaded.expiresAt) return Promise.resolve(this.#loaded)
    const service = this.deps.skills()
    if (service === undefined) return Promise.resolve(serialize([]))
    this.#inflight ??= service.list()
      .then((summaries) => {
        const loaded = serialize(summaries.map(toWireSkill))
        if (this.deps.ttlMs > 0) this.#loaded = { ...loaded, expiresAt: now() + this.deps.ttlMs }
        return loaded
      })
      .finally(() => {
        this.#inflight = undefined
      })
    return this.#inflight
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
