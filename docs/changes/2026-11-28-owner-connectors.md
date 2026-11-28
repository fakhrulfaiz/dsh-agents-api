# Owner connector keys in the API (2026-11-28)

Spec: `agentry-web/docs/superpowers/specs/2026-11-26-agents-import-and-owner-connectors-design.md` (part 1).

## What moved

Before, the web app kept each user's Composio consumer key in its own encrypted file and added a `composio` MCP tool (key in its headers) to the body of `POST /agents/sessions` only. Sessions the web app did not create (scheduled runs, `agent_id`-only creates, API clients, sessions made by tools) had no connectors, a replaced key never reached existing sessions, and the key sat in plain text in the session's saved config in Postgres.

Now the API is the only holder of the key:

- Table `owner_secrets (owner_id, name, sealed, last4, created_at, updated_at)` (migration `0006-owner-secrets.sql`). Values are sealed with AES-256-GCM under a key derived with HKDF-SHA256 from `secrets.key` (`AGENTRY_SECRETS_KEY`, at least 32 bytes), with `owner_id + "\0" + name` as authenticated data, so a row cannot be moved to another owner. Generic by name (`composio` now; later per-owner model keys). Code: `src/secrets/seal.ts`, `src/secrets/owner-secrets.ts`, `src/store/postgres-secrets.ts`.
- Routes `GET|POST|DELETE /agents/connectors/composio` and `GET /agents/connectors/composio/connections?toolkits=` (`src/connectors/`). Responses carry `last4` only. See `docs/http-api.md` "Connector keys".
- Mount time: `AgentsGateway.buildAgentSetup` adds a `composio` MCP tool built from the stored key (`src/mount-owner-composio.ts`) on every create and resume, before the Composio relay rewrite, grants and approvals. It lives in memory only; the saved session config never holds it. Not added when the session's own tools already have the `composio` label (sessions the web app created before this change keep theirs).

## Behaviour

- Agents whose grants allow no app (`apps: {}`, or every app with an empty tool list) get no owner tool, so they start without contacting Composio, as fast as before. Agents with any app (`apps` absent) or some apps get it.
- Key changes apply when a session's agent is next created or resumed (a new chat, a scheduled run resuming after a restart, a server restart). A live chat keeps the key it started with; removing a key does not cut a running chat.
- `secrets.key` unset: the key routes answer `501 secrets_disabled`; sessions mount without an owner key (the profile-wide row still applies).
- `secrets.key` changed: stored rows cannot be opened; the API logs one warning per owner and treats the key as missing (status `configured: false`). The user pastes the key again.
- Composio unreachable at session start: `required: false`, so the session starts without Composio tools.
- The profile-wide `mcp-composio` row (`COMPOSIO_API_KEY`) stays as the single-user fallback; an owner's key, mounted under the same label at agent scope, shadows it. Multi-user deployments must leave `COMPOSIO_API_KEY` empty.

## Config

- `secrets.key` (`cordis.patch.yml`: `AGENTRY_SECRETS_KEY`); `openssl rand -base64 48`. Shorter than 32 bytes fails startup.
- `composio.mcpUrl` (default `https://connect.composio.dev/mcp`).

## Moving existing keys

The web app moves a key from its file store the first time the signed-in user's Connectors status is read (`GET /api/agentry/connectors/key`) and the API says `configured: false`. The move is made with the user's own credential, so it lands under the API owner (in apikey mode that is the dev key's owner, `dev`, not the web's `apikey` slot).
