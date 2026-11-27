# Sandboxes

The gateway runs agent work in an **environment**. Where an environment lives is decided by a **sandbox provider**, registered in the `SandboxRegistry`. The gateway never names a concrete provider, so a Docker, VM or hosted backend is added by registering one; nothing else changes.

## Wire compatibility

Environments, templates and environment files follow the OpenAI Agents API as the OpenAI Python SDK defines it, so the SDK client works against this gateway. We may return extra optional fields (`provider`, `provider_metadata`, `image`, `unsupported_fields`, `template_id`, `session_id`, `error`); we never return fewer fields than the SDK defines and never reject input the SDK accepts.

| Resource | Shape |
|---|---|
| Template | `agent.environment.template` with `files`, `env`, `network`, `packages`, `plugins`, `skills`, `capability_directories`, `setup_commands` (+ extension `image`, `provider`) |
| Environment | `agent.environment`, `type` `self_hosted` (local provider) or `openai_hosted` (any other), `status` `pending` `connected` `disconnected` `expired` `failed` |
| File | `agent.environment.file`, absolute `/workspace/...` path, `size_bytes`; list is a token page (`limit`, `order`, `page`, `path`; `data`, `has_more`, `next`) |

A template field the chosen provider cannot apply is **stored and listed** (`unsupported_fields`), never dropped. Provisioning it answers 400 `sandbox_template_unsupported`. A file referenced by `file_id` is copied from the owner's uploads (`POST /agents/files`) into the workspace when the environment is provisioned; the upload stays reusable, and an id that is not the owner's answers 400.

## Using a provider

- `GET /agents/environments/providers` lists each provider, whether it is the default, and its capabilities (`templateFields`, `files`, `exec`).
- `POST /agents/environments` with `template_id` and/or `provider` provisions an environment. An unknown provider answers 400 naming the registered ones.
- A session uses a hosted environment with `environment: { "type": "openai_hosted", "environment_template_id": "..." }` or the same type with inline template fields and `provider`. `environment: { "type": "sandbox", "environment_id": "..." }` attaches an existing one. A provider whose `exec` capability is false answers 400 `sandbox_exec_unavailable`.
- A bare `{ "type": "openai_hosted" }` provisions nothing and uses the session's default workspace.

## Runtimes

Node, Python and pnpm are not chosen per environment. The host bundles one payload (`~/.dsh/office-runtime/primary-runtime`, or `AGENTRY_OFFICE_RUNTIME`) that every session shares; the `workspace-dependencies` tool tells agents where it is, and the Office skills use it. `GET /agents/environments/runtimes` (extension) reports the versions and Python packages from the payload's `runtime.json`, or `available: false` when there is none. Choosing a different runtime per environment needs a container provider with an `image`.

## Adding a provider

Implement `SandboxProvider` (`src/sandbox/contract.ts`): `kind`, `capabilities`, and the `EnvironmentProvider` methods (`create`, `status`, `destroy`, `listFiles`, `readFile`, `writeFile`). Register it where `src/index.ts` builds the registry. The bundled `local` provider is the reference: `{ templateFields: ['files'], files: true, exec: true }`.

DSH itself resolves one filesystem and subprocess provider per composition, so a provider that must run an agent's commands in a remote sandbox needs a DSH-side plugin that routes the agent's tools there. Until one exists, such a provider declares `exec: false` and can hold files only.

Codebox is removed; its settings are rejected at load by name.

## Agentry Sandbox (`sandbox` provider)

Registered when `sandbox.url` and `sandbox.key` are configured (or `AGENTRY_SANDBOX_URL` / `AGENTRY_SANDBOX_KEY`; one without the other fails startup). The service is the separate `agentry-sandbox` project (Docker backend today: hardened containers, internet-only egress, per-owner limits; E2B's envd inside each sandbox).

- **Create**: `POST /agents/environments` with `provider: "sandbox"` (or a template whose provider is `sandbox`). Template fields map to the service template: `image`, `packages.system` → apt/apk packages, `packages.python` → `pip install --user`, `packages.npm` → `sudo npm install -g`, `setup_commands` (and legacy `setup`) in order, `env`, `network.access: disabled` → no network, `files`/`starter_files`. A service refusal (a limit, an unavailable backend) leaves the environment `failed` with the service's message.
- **Paths**: a sandbox mounts its workspace disk at `/workspace`; the API host needs no such folder. DSH's host-level working-directory service would check every session's folder through the host's file system, so this bundle mounts `@agentry/api/working-directory` in its place (`cordis.patch.yml` disables the base `working-directory` row): for an Agent whose preset supplies its own `workingDirectory` (a sandbox session: `agentry-sbx-*` mounts `dsh-working-directory` in its isolated group) it hands `ensure()` to that service, which checks the folder inside the sandbox; every other session is handled exactly as DSH does. On shared machines (SSH-machine places, or when the place cannot be determined) a sandbox mounts at the unique path `<workspaces>/<owner>/sandbox-<environment_id>` (an empty placeholder of that name is kept on the host and removed on delete). Nothing is translated either way. In a sandbox not mounted at `/workspace` (older sandboxes, shared machines), `/workspace` also reaches the workspace through a link made on first use.
- **Lifecycle**: `POST /agents/environments/{id}/start | stop | reset` (`keep_workspace`, default true). `local` answers 409 `environment_not_startable`; service limits answer 429. A stopped sandbox starts again on the next tool call.
- **Sessions**: a session on a sandbox environment mounts the preset `agentry-sbx-<sandbox_id>`: the `agentry` rows inside one isolated group (`ssh`, `subprocess`, `shell`, `fs`, `workingDirectory`, `sandbox`, `sandboxPolicy`, `ptcRuntime`, `terminals`) with `@agentry/api/sandbox-runtime`, `dsh-sandbox-policy`, `dsh-working-directory` and `dsh-bash-sandbox`. Every tool — bash, file tools, search, jobs, present, workflow (PTC), subagents — acts inside the sandbox. One registration serves all sessions on a sandbox; it is released 5 minutes after the last one ends and removed at once when the environment is deleted.
- **Execution**: `@agentry/api/sandbox-runtime` runs DeepSeek Harness's own remote providers (`dsh-fs-ssh`, `dsh-subprocess-ssh`, `dsh-sandbox-ssh`, `dsh-ptc-runtime-node`) over `EnvdSshConnection`, a drop-in `ssh` service whose transport is the sandbox's envd: DSH's helper (installed with Node at `/opt/agentry/dsh` by the service) runs inside the sandbox; administrative RPC rides its stdin/stdout; each program stream is a small envd process piping to the helper's Unix socket, authenticated end to end with the helper's TLS-PSK key. After a transport loss (e.g. the sandbox was stopped) the next call starts a new helper; nothing in flight is replayed.
- **Permissions**: sandbox sessions start in `danger-full-access` (the container is the boundary and `agent` has passwordless sudo there; DSH's in-container confinement would set `no_new_privs` and break sudo). Switching the session's mode still works and DSH's Landlock enforcement is effective inside the container.
- **Skills**: the owner's skills and the built-ins are copied into the sandbox at their identical host paths (root-owned, read-only for `agent`) when the preset is first registered.
- **Workspace data**: session artifacts (list and read) and attachment copies into `uploads/` go through the provider; deliverables come from the session log.
- **Web browser**: an agent with `browser: true` gets Playwright MCP (`mcp__browser__*`) in sandbox chats, running inside the sandbox; the API host runs only the stdio bridge (`lib/sandbox-stdio-bridge.js`), which starts `playwright-mcp` over an envd process stream. The standard image ships it (older sandboxes: reset). Local chats get no browser. See `docs/changes/2026-11-26-browser.md`. Live view cursor: the relay installs a pointer listener in the page it shows (CDP binding `__agentryPointer`, top frame only, trusted events only) and adds two relay lines, `{"type":"pointer","action":"move"|"down"|"up","x","y","ts"}` (at most 30 a second, down and up never dropped) and `{"type":"focus","x","y","width","height","ts"}`; the live stream sends them as `pointer` and `focus` events (viewport CSS px, never replayed). See `docs/changes/2026-11-27-browser-cursor.md`.
- **Security**: the service key stays server-side — it is never in preset rows (the API passes it to the runtime plugin in-process), responses, or the browser. The helper's digest and PTC bootstrap digest are checked against the sandbox's `/opt/agentry/dsh/manifest.json` at every connection.
