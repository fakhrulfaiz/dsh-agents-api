# Pluggable sandbox providers (design)

Status: 2026-11-11, draft for review. Not implemented. Facts below were read from `src/environment/*`, `src/environment-types.ts`, `docs/http-api.md`, `AGENTS.md` and the DSH checkouts; nothing was run. This spec is the main direction for sandboxes. The per-user container spec (`2026-11-10-per-user-sandbox-design.md`) stays as a separate, complementary layer.

## Goal

Make `dsh-agents-api` work with any sandbox through one stable contract, with each sandbox shipped as its own plugin and none hardcoded: local directories today, then Docker, a hosted service, or anything else someone writes.

## Understanding

- **Environment templates** come from the OpenAI Agents API: "reusable configuration that provisions a fresh hosted environment for each session", as a saved agent is a recipe for an agent. The real shape (read from the OpenAI Python SDK that `agents-api-client` uses) is `files` (inline base64 or `file_id`, with a destination path), `env`, `network` (`enabled`, `disabled` or `restricted` with allowed domains), `packages` (`npm`, `python`, `system`), `plugins`, `skills`, `capability_directories`, `setup_commands` and `name`. A session sets `environment: { type: "openai_hosted", environment_template_id, ...inline overrides }`. Our stored template is a different, Codebox-style blueprint (`config.image`, `setup`, `packages[]`, `starter_files`, `default_env`) under non-SDK object names; see "Compatibility with the OpenAI Agents API". Codebox is dropped (decision 2026-11-11).
- **Today's seam:** `EnvironmentProvider` (`src/environment/provider.ts`) has `kind: 'local' | 'codebox'` (the parked Codebox half is removed in phase 1) and methods `create`, `status`, `destroy`, `listFiles`, `readFile`, `writeFile`. One instance is chosen at startup. The local provider manages directories under `<workspaces>/<owner>/<environment_id>/`; `type: sandbox` answers an error.
- **A provider that only manages files and lifecycle is not enough** to run an agent in a sandbox: the agent's own file and shell tools run in the Host process. DSH allows one `ctx.fs` and one `ctx.subprocess` provider per composition (loading a second fails), so a sandbox cannot simply be mounted beside them.
- **What exists to reuse:** DSH's SSH family implements the file and subprocess contracts remotely but for one host and the whole profile (our decisions forbid it); its E2B packages were retired upstream and are not in the pin `dsh-v0.2.2-rc.1`. Our parked `CodeboxClient` (`src/environment/codebox.ts`) is removed, not reused. No per-session sandbox implementation exists.

## Design

### 1. The contract

`SandboxProvider` extends today's `EnvironmentProvider`:

- `kind: string` is a free provider name (`local`, `docker`, ...), no longer a closed union.
- `capabilities`: `{ templateFields: ('files'|'env'|'network'|'packages'|'plugins'|'skills'|'capability_directories'|'setup_commands'|'image')[]; files: boolean; exec: boolean }`. The names are the SDK's template field names; `image` is our one extension (a container image for container providers). `exec` says whether the provider can run the agent's commands (needs a dispatch backend, section 3).
- The existing lifecycle and file methods, unchanged in meaning. `create` returns a provider handle stored in `provider_metadata` (container id, box id).
- `target(record)`, optional: the object the dispatch plugin uses to run commands and file operations for that environment. Providers with `exec: false` omit it.

### 2. Registry and plugins

- A Cordis service owned by this package, `ctx.agentrySandbox`, with `register(provider)`. Config: `sandbox: { default: 'local', providers: [...] }`; provider plugins register themselves when mounted in the profile.
- Packages: `@agentry/sandbox-local` (today's local provider, extracted, default) and `@agentry/sandbox-docker` (new). Phase 1 keeps the local provider in this repo behind the contract; separate packages come with the Docker provider. They live in a small workspace in this repo or their own repos; the contract is exported from `@agentry/api`.
- Selection: a template names its `provider`; `environment_id` uses the record's provider; session create with `type: sandbox` and neither falls back to `default`. An unknown provider answers 400 listing the registered names.
- Templates are validated against the provider's `capabilities.templateFields`: an unsupported field is rejected at template create, never silently ignored.
- `GET /agents/environments/providers` lists `{ name, capabilities }` for clients.

### 3. Running the agent's tools inside a sandbox

A new DSH plugin, `@agentry/sandbox-dispatch`, is the single `ctx.fs` and `ctx.subprocess` provider in the Agentry profile and routes each call by the session's workspace root: the default route is the local implementation (behaviour identical to today), and a root owned by a sandbox environment routes to that provider's `target`. This satisfies DSH's one-provider rule without an upstream change.

- **Cost:** the dispatcher must satisfy the full fs and subprocess contracts (resolve, read, write, patch, move, watch, locks, spawn, PTY, termination) over each target. This is the largest item in the plan and is gated by a spike (phase 5): how much of the SSH family's helper protocol and code can be reused per target, and what the minimum viable subset is.
- **Until then:** providers with `exec: false` are usable for lifecycle, file access, artifacts and starter files, and session create with such an environment answers a clear error naming the missing capability. Only `local` runs agents. The API never implies more.

### 4. Docker provider (`@agentry/sandbox-docker`)

- Talks to a Docker Engine API endpoint from config: a unix socket path, or an HTTPS URL with client certificates. By default it targets a separate Docker host or a socket proxy, not a socket inside the harness (see the Docker access rules in the per-user container spec).
- Fixed container options: our label, user, read-only root, dropped capabilities, resource limits, a private network with egress policy. `image` from a template must match `allowedImages` in config; a template cannot choose arbitrary images, mounts or privileges.
- `setup` runs once after start; `packages` and `starter_files` and `default_env` are applied at create. Capabilities: `files: true`, `exec` true only when the dispatch backend lands.

### 5. Web app

The Environments page lists providers with their capabilities, templates with a form limited to the provider's fields, and environments with state. New chat gets an environment menu next to the agent menu. Designed in a later spec after phase 2.

## Compatibility with the OpenAI Agents API

The OpenAI Python SDK is the contract (`agents-api-client` points `OpenAI(base_url=...)` at this server and calls `client.beta.agents...`). Audit of the installed SDK against our current routes, 2026-11-11:

| Area | SDK | Ours today | Decision |
|---|---|---|---|
| Routes | templates CRUD, `GET /agents/environments/{id}`, `.../files` | same paths, plus `POST` and `GET /agents/environments` and a file read route | keep paths; our extra routes stay as extensions |
| Object names | `agent.environment`, `agent.environment.template`, `agent.environment.template.deleted`, `agent.environment.file` | `environment`, `environment.template`, `environment.template.deleted`, `environment.file` | emit the SDK names |
| Template body | flat: `files`, `env`, `network`, `packages{npm,python,system}`, `plugins`, `skills`, `capability_directories`, `setup_commands`, `name` | nested `config{image,setup,packages[],starter_files,default_env}` | accept and emit the SDK shape; read old stored templates through a compatibility mapping |
| Environment | `type` (`openai_hosted` or `self_hosted`), `files`, `skills`, `plugins`, `status` in `pending, connected, disconnected, expired, failed` | `provider`, `provider_metadata`, `template_id`, `session_id`, statuses incl. `cleanup`, `deleted` | emit the SDK fields; keep `provider`, `provider_metadata`, `template_id`, `session_id` as optional extension fields; map statuses |
| Session `environment` | `none`, `openai_hosted` (inline fields and `environment_template_id`), `self_hosted` (`workspace_directory`) | also `local` and `sandbox` | `openai_hosted` provisions through a provider; `self_hosted` is the existing directory case; `local` and `sandbox` stay accepted as aliases |

Rules: SDK object names, field names and status values are the contract; our additions are optional extension fields (the SDK's models tolerate extra fields), so we may return more than the SDK defines but never less, and we accept everything the SDK accepts. A template the provider cannot fully honour is still accepted and stored with `unsupported_fields` listed; provisioning fails with a clear error naming the fields when they matter (for example a restrictive `network`), so nothing is silently ignored; and acceptance is running the SDK-based smokes in `agents-api-client` (`sandbox_smoke.py`) against the server, not only our own tests. Mapping of old stored templates: `config.starter_files` to `files` (inline), `config.default_env` to `env`, `config.setup` to `setup_commands`, `config.packages` to `packages.system`, `config.image` to the `image` extension.

A provider's `openai_hosted` environment is "how a fresh sandbox is provisioned from a template"; the provider is chosen by the template's `provider` extension, else the default.

## Relationship to per-user containers

Independent layers. Per-user containers isolate users from each other; sandboxes isolate a session's tools from the harness. Both can be used together, and neither depends on the other.

## Phases

1. Remove Codebox (client, config rejection, wire literals, docs). Extract the contract and registry; move the local provider behind it with no behaviour change. Tests first.
2. Align the template and environment resources and the session `environment` union with the SDK (see "Compatibility with the OpenAI Agents API"), provider names and capabilities, validation errors, and `GET /agents/environments/providers`; run the SDK smokes.
3. (Removed: Codebox is dropped.)
4. Docker provider for lifecycle and files, tested against a throwaway Docker host.
5. Spike: dispatcher feasibility and SSH-family reuse; report scope and a go or no-go.
6. Dispatcher plugin and `exec` for the Docker provider.
7. Web Environments page.

## Out of scope

Codebox (dropped), pools of warm sandboxes, snapshots and checkpoints, GPUs, billing and quotas, cross-owner sharing, hosted-vendor adapters (they can be written later as providers against the same contract), and any change to DeepSeek's repositories.

## Open items to verify before a plan

- Whether the DSH fs and subprocess contracts can be implemented over `docker exec` or the SSH helper protocol with acceptable fidelity (PTY, watch, patch).
- How a remote workspace path maps to the session cwd, and how artifact listing, uploads and `GET .../artifacts` (which read host directories today) work for remote workspaces.
- The Docker host access model and the image allowlist policy.
- How the Cordis service for provider registration is typed and injected alongside `@agentry/api` (the plugin is a function plugin; check the injection pattern).
- Interaction with scheduled tasks and session resume when the sandbox is stopped.
