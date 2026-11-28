/**
 * The owner's Composio consumer key, stored sealed in the API (Agentry extension, owner scoped):
 *
 * - `GET /agents/connectors/composio`: `{ object, configured, last4, updated_at }`, never the key.
 * - `POST /agents/connectors/composio` `{ key }`: save or replace it (400 `invalid_key` unless it starts with `ck_`).
 * - `DELETE /agents/connectors/composio`: remove it.
 * - `GET /agents/connectors/composio/connections?toolkits=a,b`: the owner's accounts per toolkit.
 *
 * Without `secrets.key` the key routes answer 501 `secrets_disabled`. A saved key reaches sessions
 * when their agent is next created or resumed (`mount-owner-composio.ts`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OwnerId } from '../auth/authenticator.ts'
import type { Route } from '../gateway.ts'
import { json, readBody } from '../http.ts'
import { COMPOSIO_SECRET } from '../mount-owner-composio.ts'
import type { OwnerSecrets, SecretStatus } from '../secrets/owner-secrets.ts'
import { listInventory } from './composio-status.ts'

/** Toolkit slugs as Composio writes them. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/u
/** Most toolkits one connections call asks about. */
const MAX_TOOLKITS = 500
/** Longest accepted key. */
const MAX_KEY_LENGTH = 512

/** Dependencies of {@link ComposioConnectorsApi}. */
export interface ComposioConnectorsDeps {
  secrets: OwnerSecrets
  /** Composio's MCP endpoint (`composio.mcpUrl`). */
  mcpUrl: string
  /** Replaceable for tests. */
  fetch?: typeof fetch
}

function fail(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  json(res, status, { error: { type: status >= 500 ? 'server_error' : 'invalid_request_error', message, code, ...extra } })
}

const body = (status: SecretStatus) => ({ object: 'connector.key', ...status })

/** Routes for the owner's Composio key and connections. */
export class ComposioConnectorsApi {
  constructor(private readonly deps: ComposioConnectorsDeps) {}

  routes(): Route[] {
    return [
      { method: 'GET', pattern: '/agents/connectors/composio', handler: (_req, res, _url, _params, p) => this.status(res, p.owner) },
      { method: 'POST', pattern: '/agents/connectors/composio', handler: (req, res, _url, _params, p) => this.save(req, res, p.owner) },
      { method: 'DELETE', pattern: '/agents/connectors/composio', handler: (_req, res, _url, _params, p) => this.remove(res, p.owner) },
      { method: 'GET', pattern: '/agents/connectors/composio/connections', handler: (_req, res, url, _params, p) => this.connections(res, url, p.owner) },
    ]
  }

  private disabled(res: ServerResponse): boolean {
    if (this.deps.secrets.enabled) return false
    fail(res, 501, 'secrets_disabled', 'This server cannot store connector keys. Ask the administrator to set AGENTRY_SECRETS_KEY.')
    return true
  }

  private async status(res: ServerResponse, owner: OwnerId): Promise<void> {
    if (this.disabled(res)) return
    json(res, 200, body(await this.deps.secrets.status(owner, COMPOSIO_SECRET)))
  }

  private async save(req: IncomingMessage, res: ServerResponse, owner: OwnerId): Promise<void> {
    if (this.disabled(res)) return
    const raw = (await readBody(req))['key']
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (!key.startsWith('ck_') || key.length <= 3 || key.length > MAX_KEY_LENGTH || /\s/u.test(key)) {
      fail(res, 400, 'invalid_key', 'Enter a valid connector key (it starts with ck_).')
      return
    }
    json(res, 200, body(await this.deps.secrets.set(owner, COMPOSIO_SECRET, key)))
  }

  private async remove(res: ServerResponse, owner: OwnerId): Promise<void> {
    if (this.disabled(res)) return
    json(res, 200, body(await this.deps.secrets.remove(owner, COMPOSIO_SECRET)))
  }

  private async connections(res: ServerResponse, url: URL, owner: OwnerId): Promise<void> {
    const slugs = [...new Set((url.searchParams.get('toolkits') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(s => s !== ''))]
    if (slugs.length === 0 || slugs.length > MAX_TOOLKITS || !slugs.every(s => SLUG.test(s))) {
      fail(res, 400, 'bad_request', `toolkits must be a comma-separated list of 1 to ${String(MAX_TOOLKITS)} toolkit slugs`)
      return
    }
    const key = await this.deps.secrets.get(owner, COMPOSIO_SECRET)
    if (key === undefined) {
      fail(res, 409, 'connector_key_missing', 'No connector key is stored for you.')
      return
    }
    const result = await listInventory(key, slugs, this.deps.mcpUrl, this.deps.fetch)
    if (!result.ok) {
      fail(res, 502, 'connector_unavailable', result.reason === 'rejected' ? 'Composio refused the connector key.' : 'Composio could not be reached.', { reason: result.reason })
      return
    }
    json(res, 200, { object: 'connector.connections', data: result.inventory })
  }
}
