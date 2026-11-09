/**
 * `GET /v1/agents/commands`: the Host slash-command catalog for the `/` menu.
 *
 * Command definitions are layered per agent scope (global definitions plus
 * per-agent shadows), so a catalog is read for one session: the live agent of
 * `?session_id=` (owned by the caller), or the default preset scope when that
 * session has no live agent, without resuming it. Without `session_id` the
 * list is empty because preset-scoped commands need an agent. Catalogs are
 * cached in memory per scope for a configured TTL, dropped whenever the
 * registry or a session's preset changes, and served with a strong `ETag`.
 */

import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'
import type { OwnerId } from './auth/authenticator.ts'
import type { Route } from './gateway.ts'
import { errorMessage, json, notFound } from './http.ts'
import { matchesEtag } from './skills.ts'
import type { AgentCommand } from './types.ts'

/** The registry view one catalog request reads. */
export interface CommandTarget {
  /** Scope key whose layers are visible (a live agent or the default preset scope); `undefined` reads the global layer alone. */
  scope: object | undefined
  /** Releases a lease held on `scope`; called once the request finished reading. */
  release?: () => PromiseLike<void>
}

/** What `CommandsApi` needs from the gateway. */
export interface CommandsApiDeps {
  /** The Host command registry, read at call time; `undefined` answers an empty list. */
  commands: () => { list: (agent: never) => readonly CommandDescriptor[] } | undefined
  /**
   * Resolve the registry view of a session.
   * @param owner - authenticated caller.
   * @param sessionId - `session_id` query value.
   * @returns the target, or `undefined` when `sessionId` is not a session of `owner`.
   */
  resolveTarget: (owner: OwnerId, sessionId: string) => Promise<CommandTarget | undefined>
  /** Milliseconds a loaded catalog is served without calling `list()` again; 0 disables the cache. */
  ttlMs: number
  /** Report a failed `list()`; the response carries a generic message. */
  warn: (message: string) => void
  /** Clock in epoch milliseconds, injectable in tests. */
  now?: () => number
}

/** `Cache-Control` of every catalog response: clients always revalidate with `If-None-Match`. */
const CACHE_CONTROL = 'private, max-age=0, must-revalidate'

/** Cache key for the global-layer view. */
const GLOBAL_SCOPE = {}

/** A serialized catalog and its validator. */
interface Loaded {
  body: string
  etag: string
}

/**
 * Wire form of a command descriptor.
 * @param command - descriptor from the Host registry.
 * @returns the catalog entry; `definitionId` stays internal.
 */
export function toWireCommand(command: CommandDescriptor): AgentCommand {
  return {
    name: command.name,
    description: command.description,
    ...(command.input === undefined ? {} : { input_hint: command.input.hint }),
    accepts_attachments: command.input?.attachments === true,
  }
}

/** The command catalog route and its per-scope cache. */
export class CommandsApi {
  /** Cached catalogs by scope key; entries die with the scope object. */
  readonly #loaded = new WeakMap<object, Loaded & { expiresAt: number; generation: number }>()
  readonly #inflight = new WeakMap<object, Promise<Loaded>>()
  /** Bumped by `invalidate`; an entry loaded under an older value is stale. */
  #generation = 0

  /** @param deps - service accessor, target resolver, cache TTL, and logger. */
  constructor(private readonly deps: CommandsApiDeps) {}

  /** @returns the catalog route, to be placed before `/agents/:agent_id`. */
  routes(): Route[] {
    return [
      {
        method: 'GET',
        pattern: '/agents/commands',
        handler: (req, res, url, _params, principal) => this.list(res, principal.owner, url.searchParams.get('session_id') ?? undefined, req.headers['if-none-match']),
      },
    ]
  }

  /** Drop every cached catalog, for example after a command registered or a session switched preset. */
  invalidate(): void {
    this.#generation += 1
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
      if (sessionId === undefined) {
        loaded = serialize([])
      } else {
        const target = await this.deps.resolveTarget(owner, sessionId)
        if (target === undefined) {
          notFound(res, `Session "${sessionId}" not found`)
          return
        }
        try {
          loaded = await this.load(target)
        } finally {
          await target.release?.()
        }
      }
    } catch (error: unknown) {
      this.deps.warn(`agents-api: command catalog failed to load: ${errorMessage(error)}`)
      json(res, 503, { error: { type: 'server_error', message: 'The command catalog could not be loaded', code: 'commands_unavailable' } })
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
   * The serialized catalog of one scope: cached while fresh, otherwise one shared read.
   * Failures are not cached.
   * @param target - registry view to read.
   * @returns the body and its entity tag.
   */
  private load(target: CommandTarget): Promise<Loaded> {
    const now = this.deps.now ?? Date.now
    const key = target.scope ?? GLOBAL_SCOPE
    const cached = this.#loaded.get(key)
    if (cached !== undefined && cached.generation === this.#generation && now() < cached.expiresAt) return Promise.resolve(cached)
    const service = this.deps.commands()
    if (service === undefined) return Promise.resolve(serialize([]))
    const shared = this.#inflight.get(key)
    if (shared !== undefined) return shared
    const generation = this.#generation
    const flight = Promise.resolve()
      .then(() => {
        const loaded = serialize(service.list(target.scope as never).map(toWireCommand))
        if (this.deps.ttlMs > 0) this.#loaded.set(key, { ...loaded, expiresAt: now() + this.deps.ttlMs, generation })
        return loaded
      })
      .finally(() => {
        this.#inflight.delete(key)
      })
    this.#inflight.set(key, flight)
    return flight
  }
}

/**
 * Sort entries by name and serialize them with a strong entity tag.
 * @param entries - catalog entries.
 * @returns the JSON body and `"sha256-<hex>"` tag.
 */
function serialize(entries: AgentCommand[]): Loaded {
  const data = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const body = JSON.stringify({ object: 'list', data })
  return { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` }
}
