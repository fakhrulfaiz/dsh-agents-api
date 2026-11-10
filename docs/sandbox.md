# Sandboxes

The gateway runs agent work in an **environment**. Where an environment lives is decided by a **sandbox provider**, registered in the `SandboxRegistry`. The gateway never names a concrete provider, so a Docker, VM or hosted backend is added by registering one; nothing else changes.

## Wire compatibility

Environments, templates and environment files follow the OpenAI Agents API as the OpenAI Python SDK defines it, so the SDK client works against this gateway. We may return extra optional fields (`provider`, `provider_metadata`, `image`, `unsupported_fields`, `template_id`, `session_id`, `error`); we never return fewer fields than the SDK defines and never reject input the SDK accepts.

| Resource | Shape |
|---|---|
| Template | `agent.environment.template` with `files`, `env`, `network`, `packages`, `plugins`, `skills`, `capability_directories`, `setup_commands` (+ extension `image`, `provider`) |
| Environment | `agent.environment`, `type` `self_hosted` (local provider) or `openai_hosted` (any other), `status` `pending` `connected` `disconnected` `expired` `failed` |
| File | `agent.environment.file`, absolute `/workspace/...` path, `size_bytes`; list is a token page (`limit`, `order`, `page`, `path`; `data`, `has_more`, `next`) |

A template field the chosen provider cannot apply is **stored and listed** (`unsupported_fields`), never dropped. Provisioning it answers 400 `sandbox_template_unsupported`. A file referenced by `file_id` is accepted but answers 400 until Files API copying exists.

## Using a provider

- `GET /agents/environments/providers` lists each provider, whether it is the default, and its capabilities (`templateFields`, `files`, `exec`).
- `POST /agents/environments` with `template_id` and/or `provider` provisions an environment. An unknown provider answers 400 naming the registered ones.
- A session uses a hosted environment with `environment: { "type": "openai_hosted", "environment_template_id": "..." }` or the same type with inline template fields and `provider`. `environment: { "type": "sandbox", "environment_id": "..." }` attaches an existing one. A provider whose `exec` capability is false answers 400 `sandbox_exec_unavailable`.
- A bare `{ "type": "openai_hosted" }` provisions nothing and uses the session's default workspace.

## Adding a provider

Implement `SandboxProvider` (`src/sandbox/contract.ts`): `kind`, `capabilities`, and the `EnvironmentProvider` methods (`create`, `status`, `destroy`, `listFiles`, `readFile`, `writeFile`). Register it where `src/index.ts` builds the registry. The bundled `local` provider is the reference: `{ templateFields: ['files'], files: true, exec: true }`.

DSH itself resolves one filesystem and subprocess provider per composition, so a provider that must run an agent's commands in a remote sandbox needs a DSH-side plugin that routes the agent's tools there. Until one exists, such a provider declares `exec: false` and can hold files only.

Codebox is removed; its settings are rejected at load by name.
