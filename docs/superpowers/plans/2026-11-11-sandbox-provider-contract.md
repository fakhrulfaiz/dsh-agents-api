# Sandbox Provider Contract and SDK Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `SandboxProvider` contract and registry (local provider behind it), Codebox removed, and the environment and template resources plus the session `environment` union aligned with the OpenAI Agents API as the OpenAI Python SDK defines it, so stock SDK clients work.

**Architecture:** `src/sandbox/{contract,registry}.ts` hold providers by name with a default; the gateway resolves a provider per template or environment record. Wire resources are emitted and accepted in the SDK's shapes; our fields (`provider`, `provider_metadata`, `image`, the providers endpoint) are optional extensions. Old stored templates are read through a compatibility mapping. No dispatcher and no Docker provider in this plan.

**Tech Stack:** TypeScript, Vitest, the OpenAPI contract tests, and the OpenAI Python SDK in `~/code/agents-api-client/.venv` as the compatibility reference.

**Spec:** `docs/superpowers/specs/2026-11-11-pluggable-sandbox-design.md` (including "Compatibility with the OpenAI Agents API")

## Status

- Task 1 (contract and registry), Task 2 (gateway uses the registry) and Task 3 (remove Codebox) are done and verified (typecheck clean, 609 tests pass); uncommitted.
- Rulings so far: the local provider now applies template `starter_files` (it ignored all template fields before) and declares only that capability; `createTemplate` defaults `provider` to the registry default; a `codebox` config key or `CODEBOX_*` env var is rejected by name with `CodeboxRemovedError`; `testGatewayOptions` accepts a provider or a registry.
- Tasks 4 to 7 below replace the earlier Tasks 4 to 6, which kept our Codebox-style shapes.

## Global Constraints

- The SDK's object names, field names and status values are the contract. Read them from `~/code/agents-api-client/.venv/lib/python3.12/site-packages/openai/types/beta/` (`environment_param.py`, `agents/environment_info.py`, `agents/environments/environment_template.py`, `agents/environments/template_create_params.py`, `hosted_environment_file_param.py`, `setup_command_param.py`). Our additions are optional extension fields only.
- Behaviour for existing local environments does not change: same directories, same file operations.
- Stored templates and environments written before this work (any `provider: "codebox"`, nested `config`) stay readable. Using a template or environment whose provider is not registered answers 400 naming the provider; destroying such a record removes the row and logs that no backend could clean up.
- Superset rule: responses carry every field the SDK defines plus optional extras; requests accept everything the SDK accepts. Never fewer fields, never a rejected SDK-valid request.
- Nothing is silently ignored: any SDK-valid template is accepted and stored, and the response lists the fields the template's provider cannot apply in the extension `unsupported_fields`. Provisioning (environment create, a session with `openai_hosted`) fails with 400 `sandbox_template_unsupported` naming the provider and fields when the template asks for something the provider cannot honour: a `network.access` other than `enabled`, or a non-empty `files`, `env`, `packages`, `plugins`, `skills`, `setup_commands` or `capability_directories` outside the provider's `templateFields`.
- `exec: false` providers can never back a session; error code `sandbox_exec_unavailable`.
- Every wire change updates `openapi/agentry.yaml` in the same commit; `tests/openapi-drift.spec.ts` and `tests/openapi-contract.spec.ts` must pass.
- Acceptance includes running the SDK-based smoke (`agents-api-client/sandbox_smoke.py`, read it first) against a locally started backend; do not claim compatibility from our own tests alone.
- Commits: author `fakhrulfaiz <fakhrulfaiz2003@gmail.com>`; no `Co-Authored-By` or AI attribution. This repo's working tree has another session's uncommitted changes in files this plan touches (`src/gateway.ts`, `cordis.patch.yml`, `CHANGELOG.md`, `docs/http-api.md`, `tests/gateway-history.spec.ts`): stage only your own hunks.
- Run `export DSH_ROOT=$HOME/code/dsh-pinned` before `pnpm typecheck` and `pnpm test`; `pnpm test` needs Docker for the store tests (a throwaway Postgres, never the developer's `agentry-postgres`). Never print secrets from a running backend's environment.

## Review Focus

- An old stored template (`config` with `image`, `setup`, `packages[]`, `starter_files`, `default_env`) reads back as an SDK-shaped template; a template created in the SDK shape stores and reads back unchanged.
- The SDK client can create, list, retrieve, update and delete templates and retrieve an environment against this server without errors.
- A template that names an unknown provider: 400, nothing stored. A template with fields its provider cannot apply: accepted, `unsupported_fields` listed, and provisioning fails with `sandbox_template_unsupported`.
- Two owners: provider selection, templates and environments stay owner-scoped.
- `local` and `sandbox` session environments still work as aliases; `openai_hosted` with a template provisions through the provider.
- The providers endpoint lists every registered provider with capabilities and the default.

---

### Tasks 1 to 3: done

Contract and registry (`src/sandbox/`), gateway resolving providers per record, Codebox removed. Task 4 changes `TemplateField` from the Codebox-style names to the SDK's names and updates the local provider's capabilities accordingly.

### Task 4: SDK-shaped templates

**Files:**
- Create: `src/environment/template-compat.ts`
- Modify: `src/sandbox/contract.ts` (`TemplateField` becomes `'files' | 'env' | 'network' | 'packages' | 'plugins' | 'skills' | 'capability_directories' | 'setup_commands' | 'image'`), `src/environment/local.ts` (capabilities `['files']`; apply inline `files` at create), `src/environment-types.ts` (SDK-shaped template types), `src/gateway.ts` (template create, update, get, list, delete), `openapi/agentry.yaml`
- Test: `tests/template-compat.spec.ts`, `tests/gateway.spec.ts`, `tests/sandbox-registry.spec.ts` (update the local capabilities expectation), openapi contract tests

**Interfaces:**
- Produces:
  - `interface SdkTemplate { id: string; object: 'agent.environment.template'; name: string | null; created_at: number; updated_at: number; files: {...safe file metadata}[]; network: { access: 'enabled'|'disabled'|'restricted'; allowed_domains?: string[] }; packages: { npm: string[]; python: string[]; system: string[] }; plugins: unknown[]; skills: unknown[]; capability_directories: string[]; provider?: string; image?: string }` (match the SDK model's field names and types exactly; check `environment_template.py`).
  - `toSdkTemplate(stored: EnvironmentTemplate): SdkTemplate` and `fromTemplateInput(body: unknown, defaultProvider: string): { template: EnvironmentTemplate } | { error: string }`, where the stored `config` holds the SDK-shaped fields and legacy keys are mapped on read: `starter_files` to inline `files`, `default_env` to `env`, `setup` to `setup_commands`, `packages` array to `packages.system`, `image` to the `image` extension.
  - Validation: `provider` (extension, default from the registry) must be registered (400 otherwise). Fields are never rejected for being unsupported: `toSdkTemplate` adds `unsupported_fields: string[]` (the non-empty fields outside the provider's `capabilities.templateFields`).
  - `unsupportedFields(template: EnvironmentTemplate, provider: SandboxProvider): string[]`, reused by Task 6 at provisioning.

- [ ] **Step 1: Write the failing tests** — `toSdkTemplate` on a legacy stored template (`config: { image: 'base', starter_files: [{ path: 'a.txt', content: 'x' }], default_env: { K: 'v' }, setup: 'make', packages: ['git'] }`) returns the SDK object name, `files` with `a.txt`, `packages.system: ['git']`, `image: 'base'`; `fromTemplateInput` of an SDK-shaped body round-trips; an unknown provider returns an error naming it; a template with `network: { access: 'disabled' }` and `skills` for the local provider is accepted (201), stored, and read back with `unsupported_fields: ['network', 'skills']`; through the gateway: create answers 201 with object `agent.environment.template`, list/get/update/delete use the SDK names (`agent.environment.template.deleted` on delete), and `GET` of a stored legacy template works.
- [ ] **Step 2: Run** `pnpm vitest run tests/template-compat.spec.ts tests/gateway.spec.ts tests/sandbox-registry.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the types, mapping, validation and gateway wiring; update `openapi/agentry.yaml` (template schema, object names, delete response).
- [ ] **Step 4: Run** the same tests plus `pnpm typecheck` and the openapi tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat: SDK-shaped environment templates`.

### Task 5: SDK-shaped environments

**Files:**
- Modify: `src/environment-types.ts`, `src/gateway.ts` (environment get, list, create, delete and the file routes), `openapi/agentry.yaml`
- Test: `tests/environment.spec.ts`, `tests/gateway.spec.ts`, `tests/coreagent-surface.spec.ts`

**Interfaces:**
- Produces: environment responses with `object: 'agent.environment'`, `type: 'openai_hosted' | 'self_hosted'` (local environments are `self_hosted`, provider-provisioned ones `openai_hosted`), `files`, `skills`, `plugins` (empty arrays when none), `status` in `pending | connected | disconnected | expired | failed` (internal `cleanup` maps to `disconnected`, `deleted` to `expired`; keep the internal values in storage), plus the extension fields `provider`, `provider_metadata`, `template_id`, `session_id`, `error`; file responses `{ object: 'agent.environment.file', environment_id, path, size_bytes }` for write and list; delete answers `agent.environment.deleted` only if the SDK defines it (check `types/beta/agents/environments`; otherwise keep our current delete body).

- [ ] **Step 1: Write the failing tests** for each response shape above, including the status mapping and that an environment created by the local provider reads as `type: 'self_hosted'`.
- [ ] **Step 2: Run** `pnpm vitest run tests/environment.spec.ts tests/gateway.spec.ts tests/coreagent-surface.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the serializers and use them in every environment route; update the OpenAPI schemas.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: SDK-shaped environments`.

### Task 6: Session environment union

**Files:**
- Modify: `src/gateway.ts` (`resolveSessionWorkspace`), `openapi/agentry.yaml`
- Test: `tests/gateway.spec.ts`, `tests/coreagent-surface.spec.ts` (the case that currently expects sandbox sessions to be rejected)

**Interfaces:**
- Consumes: the registry, Tasks 4 and 5.
- Produces: `environment` accepted as `none`; `self_hosted { workspace_directory }` (existing behaviour; `local` stays an alias); `openai_hosted { environment_template_id?, inline overrides... }` provisioning an environment through the template's provider (else the default) and using its workspace as the session cwd; `sandbox { template_id?, environment_id? }` kept as an alias of `openai_hosted` / attach. A provider with `exec: false` answers 400 `sandbox_exec_unavailable` naming it; an unregistered provider answers 400 naming it; a template with fields the provider cannot honour (`unsupportedFields` from Task 4) answers 400 `sandbox_template_unsupported` naming provider and fields, before anything is provisioned.

- [ ] **Step 1: Write the failing tests** — `openai_hosted` with a template and the local default provisions an environment (record `type: 'openai_hosted'`) and uses its directory as cwd; inline `files` are written; attaching another owner's environment is 404; `exec: false` fake provider answers `sandbox_exec_unavailable`; a legacy `codebox` record answers 400 naming the unregistered provider; `none`, `self_hosted` and `local` behave as before.
- [ ] **Step 2: Run** `pnpm vitest run tests/gateway.spec.ts tests/coreagent-surface.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the resolution and OpenAPI changes.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: sessions on hosted environments through providers`.

### Task 7: Providers endpoint, SDK smoke and docs

**Files:**
- Modify: `src/gateway.ts` (route `GET /agents/environments/providers`, registered before the `{id}` routes), `openapi/agentry.yaml`, `docs/http-api.md`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/README.md`
- Create: `docs/sandbox.md`
- Test: `tests/gateway.spec.ts`

**Interfaces:**
- Produces: `GET /agents/environments/providers` answering `{ object: 'list', data: [{ name, capabilities: { templateFields, files, exec }, default }] }` (an extension; the SDK has no such route).

- [ ] **Step 1: Write the failing test** for the endpoint (local default with its capabilities; a second registered fake provider appears).
- [ ] **Step 2: Run** `pnpm vitest run tests/gateway.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the endpoint; write `docs/sandbox.md` (the SDK mapping table, templates explained, the provider contract and capabilities, selection rules, error codes, extensions list, how to write a provider, what is not done: dispatcher, Docker provider, web page; Codebox removed) and update the other docs and the changelog (breaking notes: object names, status values, `provider_metadata`, template body shape).
- [ ] **Step 4: SDK acceptance:** start the backend as the developer does (never print its environment), read `agents-api-client/sandbox_smoke.py`, and run it plus a short SDK script that creates, lists, retrieves, updates and deletes a template and retrieves an environment. Record what passed and what did not in `docs/sandbox.md`; fix server-side shape errors, not the SDK.
- [ ] **Step 5: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 6: Commit** `docs: sandbox providers and SDK compatibility`.
