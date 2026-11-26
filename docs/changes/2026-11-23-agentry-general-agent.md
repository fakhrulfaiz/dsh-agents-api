# Agentry as a general agent (2026-11-23)

Spec: `~/code/agentry-web/docs/superpowers/specs/2026-11-23-agentry-general-agent-design.md`.

## What changed

- **Identity.** Sessions mount the `agentry` preset (`preset-agentry` in `cordis.patch.yml`): DSH's web `standard` preset, copied verbatim except the persona ("You are Agentry, a general-purpose AI agent …") and `skill-filesystem` `includeDefaultRoots: false`. The DeepSeek Harness opener is off and `harness-dev-context` is disabled. Saved agents add `You are {name}, an agent built on Agentry. When asked who or what you are, introduce yourself as {name}, an agent built on Agentry.` `tests/agentry-identity.spec.ts` fails when the pinned `standard` preset drifts.
- **`plugin_manager`** is denied on every session; plugins are an operator action.
- **Slash commands** are limited to `commands.allow` (`goal`, `plan`, `compact`, `export`).
- **Skills.** Three kinds: built-in (`skills/`), library (owner), private (agent). An agent-scoped `agentry` provider serves each agent's resolved set; `skills` on agents selects them (absent: all built-ins; default chat also gets the library). Installed skills are indexed in Postgres (`skills`) and stored under `skills.dir`. Four install paths: upload, editor, GitHub import, and the chat tools `skill_create` / `skill_install` (approval first).
- **Composio grants.** `apps` (app → `all` | tool slugs) and `send_policy` on agents; a guard checks every call and batch entry; writes ask first under `ask`; agents created from chat get at most the caller's apps.
- **Connect requests.** `function_call_output` items carry `connect_request` when the output holds a Connect Link.

## Known limits

- `office-*` skills come from DSH's global skill layer and are always on; making them selectable needs an upstream per-scope skill filter in `dsh-skill`.
- `COMPOSIO_SEARCH_TOOLS` results are trimmed to the grants from 2026-11-26 by a generic JSON filter written without a recorded live answer; an answer in an unexpected shape passes through unfiltered (every executed call is guarded either way).
- Write detection uses slug verbs (`composio.approvalVerbs`) because live slug discovery was not possible: the profile's `COMPOSIO_API_KEY` was rejected by Composio on 2026-11-23. Add exceptions to `composio.approvalSlugs`.
- Grants are read when a session starts or resumes; an `apps` edit applies to the next session.
- The connect-request parser was written against representative shapes; no live `COMPOSIO_MANAGE_CONNECTIONS` output was recorded.
