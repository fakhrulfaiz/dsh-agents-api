# Agentry API in Docker

One image holds DeepSeek Harness at the pinned tag (`dsh.pin`), this plugin (the `agents` profile:
`dsh-base`, `dsh-web-app`, `@agentry/api`, the plugin-market bundle) and the Office runtime. No
configuration is baked in.

## Run the published image

```bash
cp agentry-api.env.example .env      # fill in POSTGRES_PASSWORD, AGENTRY_DEV_KEY, DEEPSEEK_API_KEY
docker compose up -d                 # API on http://127.0.0.1:3080 (/v1, /health)
```

`compose.yaml` and `agentry-api.env.example` are attached to every GitHub Release (the compose file
pinned to that version) and live in this folder. Compose reads `.env` for both services.

| Setting | |
|---|---|
| `POSTGRES_PASSWORD` | the bundled Postgres; letters and digits only. Or set `AGENTRY_DATABASE_URL` for another database. |
| `AGENTRY_DEV_KEY` | the API key clients and Agentry Web users sign in with (owner `dev`) |
| `DEEPSEEK_API_KEY` | the model provider key (DSH reads provider keys from the environment) |
| `COMPOSIO_API_KEY` | optional; without it the Composio entry does not start (a startup warning) |
| `AGENTRY_SANDBOX_URL` / `AGENTRY_SANDBOX_KEY` | optional, both or neither: Agentry Sandbox |
| `AGENTRY_PUBLIC_URL` | optional: the public address behind a proxy |
| `AGENTRY_API_TAG`, `AGENTRY_API_PORT` | image tag (default `latest`), host port (default 3080) |

The data volume (`/data`) holds the DSH home (`/data/dsh`: profile, settings, Session logs),
workspaces (`/data/workspaces`) and uploads (`/data/uploads`). Keep it, and the Postgres volume,
across updates. Your own profile overrides go in `/data/dsh/profiles/agents/cordis.patch.yml`; the
image refreshes the other profile files on every start and never touches that one.

The server binds the container's own address (DSH rejects wildcard binds); the port is published on
`127.0.0.1` only because it serves plain HTTP. For other machines, put a TLS reverse proxy in front
and set `AGENTRY_PUBLIC_URL`.

**Agentry Web** on the same machine reaches it at `http://host.docker.internal:3080`.

**Agentry Sandbox** chats need the sandbox service to see the same workspace paths as the API
(see the sandbox guide); running both in containers is not covered yet.

## Build it yourself

```bash
docker build --build-arg DSH_TAG=$(cat dsh.pin) -t agentry-api .
```

The build clones DeepSeek Harness (public) at the tag and Agentry Sandbox (public, `SANDBOX_REF`,
default `main`) for its client, and takes about 8 minutes the first time (DSH is cached after).

## CI

`.github/workflows/ci.yml` builds the image on pushes to `develop` and on pull requests to `main`
(plus the "version not yet released" check). `publish.yml` releases on merge to `main`: the image to
`ghcr.io/fakhrulfaiz/agentry-api` (`<version>-<sha>`, `<version>`, `latest`), the tag `v<version>`
and a GitHub Release with this folder's compose file and settings template.
