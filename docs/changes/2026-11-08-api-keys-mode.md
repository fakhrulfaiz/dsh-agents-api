# apiKeys auth mode

## What changed

- `auth.mode: apiKeys` authenticates named API keys without Keycloak, for simple self-hosting. `auth.apiKeys` is a non-empty list of `{ name, owner, roles, hash }`.
- A key is `agk_` followed by the base64url encoding of 32 random bytes (47 characters). `hash` is `sha256:` plus the lowercase hex SHA-256 of the full key. Config never holds a plaintext key.
- Verification hashes the presented bearer once and compares it with every entry's digest using `timingSafeEqual`, without exiting at the matching entry. Failures answer 401 `unauthenticated`; the presented key is never echoed.
- Load fails for an empty list, an empty or duplicate `name`, an empty `owner`, a malformed `hash`, empty `roles`, or a role other than `agentry-user`/`agentry-admin`.
- With `auth.keycloak` also set, API keys are tried first and any other bearer is verified as a Keycloak token. `devKey` is rejected in `apiKeys` mode. `production` rejects `apiKeys` entries; `development` rejects them too.
- `pnpm keys:create --name <name> --owner <owner> [--admin]` prints a new key once and the matching YAML entry. It writes no files and exits 1 with a usage line for missing, unknown, or valueless arguments.
- Revoking a key means removing its entry and restarting.

## Also in this change

- `workspaces` is a required config field. The fallback to a directory under the OS temp dir and the `AGENTS_API_WORKSPACES` env var are removed; a missing or blank value fails at load. The bundled patch reads `AGENTRY_WORKSPACES`.
- `POST /agents/sessions/{id}` writes the session index first and changes the live session only after the write succeeds, so a store failure answers 503 and leaves the session unchanged.

## Code

`src/auth/api-keys.ts`, `scripts/keys-create.ts`, `src/index.ts` (`Config`, `validateAuth`, `createAuthenticator`), `src/runtime-config.ts`, `src/gateway.ts`. Tests: `tests/api-keys.spec.ts`.
