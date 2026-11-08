# Keycloak authentication

## What changed

`Config.apiKey` is removed. The `auth` block selects how requests are authenticated:

- `mode: production` requires `auth.keycloak` (`issuer`, `audience`, `jwksTtlSeconds`, default 600) and rejects `auth.devKey` at config load.
- `mode: development` needs `auth.devKey` (`key`, `owner`, `admin`, default true) or `auth.keycloak`. With neither, config load fails.

A Keycloak token is verified with `jose` against `${issuer}/protocol/openid-connect/certs` (signature, `iss`, `aud`, expiry). The owner is `sub`; roles are the known entries of `realm_access.roles` (`agentry-user`, `agentry-admin`). The JWKS is cached for `jwksTtlSeconds`; an unknown `kid` refetches it immediately, so key rotation needs no restart.

## Wire behavior

- Missing, malformed, expired, or mismatched tokens: 401, error code `unauthenticated`, `WWW-Authenticate: Bearer`.
- A principal without the required role: 403, error code `forbidden` (`requireRole`).
- `/health` stays unauthenticated. Tokens are never logged or echoed in error bodies.

## Code

`src/auth/` holds `Authenticator`, `Principal`, `OwnerId`, and `requireRole` (`authenticator.ts`), the Keycloak verifier (`keycloak.ts`), and the development key (`static-key.ts`). `AgentsGateway` takes an `Authenticator` and passes the `Principal` as the last argument of each route handler. Owner filtering is not applied yet.

## Migration

Replace `apiKey: <key>` with `auth: { mode: development, devKey: { key: <key>, owner: <id> } }`. The bundled `cordis.patch.yml` reads the key from `AGENTRY_DEV_KEY`; with the variable unset, `devKey.key` is empty and config load fails.
