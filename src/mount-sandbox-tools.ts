/**
 * Model-facing tools for the owner's Agentry Sandbox environments:
 * `sandbox_list`, `sandbox_templates`, `sandbox_create`, `sandbox_start`,
 * `sandbox_stop`, `sandbox_exec` and `sandbox_delete`. Registered on each
 * session's agent scope when the `sandbox` provider is configured. Every call is
 * scoped to the session owner; creating and deleting ask the user first; the
 * service's limits (count, running at once, creates per hour, CPU and memory)
 * still apply and their refusals come back as the tool's error.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { runInEnvd, SandboxApiError } from '@agentry/sandbox/client'
import type { OwnerId } from './auth/authenticator.ts'
import type { SdkEnvironment } from './environment/environment-compat.ts'
import type { EnvironmentRecord, EnvironmentTemplateConfig } from './environment-types.ts'
import { AgentsApiRequestError } from './errors.ts'
import type { AgentrySandboxProvider } from './sandbox/agentry-sandbox-provider.ts'
import type { Store } from './store/store.ts'

export interface SandboxToolsDeps {
  owner: OwnerId
  store: Store
  provider: AgentrySandboxProvider
  /** Creates an environment the way `POST /agents/environments` does. */
  provision(raw: Record<string, unknown>, inline?: EnvironmentTemplateConfig): Promise<SdkEnvironment>
  /** Destroys an environment's backend (and its preset) before the record is removed. */
  destroy(record: EnvironmentRecord): Promise<void>
  /** The wire form of an environment, with the sandbox's live state. */
  describe(record: EnvironmentRecord): Promise<SdkEnvironment>
  /** The environment this chat runs in, which the tools never delete. */
  currentEnvironmentId?: string
}

export const SANDBOX_TOOL_NAMES = ['sandbox_list', 'sandbox_templates', 'sandbox_create', 'sandbox_start', 'sandbox_stop', 'sandbox_exec', 'sandbox_delete'] as const
const ASK_TOOLS = new Set<string>(['sandbox_create', 'sandbox_delete'])
const OUT_MAX = 20_000
const ERR_MAX = 8_000

type Args = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])
const tail = (text: string, max: number) => (text.length > max ? { text: text.slice(-max), cut: true } : { text, cut: false })

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false,
})
const ID = { id: { type: 'string', description: 'The sandbox id (env_...), from sandbox_list or sandbox_create.' } }

/** A refusal the model should read (limits, bad input), as opposed to a crash. */
class ToolRefusal extends Error {}

function tool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Args) => Promise<unknown>): ToolDefinition {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args: unknown) {
      try {
        return JSON.stringify(await run((args ?? {}) as Args))
      } catch (error) {
        if (error instanceof ToolRefusal || error instanceof AgentsApiRequestError || error instanceof SandboxApiError) return JSON.stringify({ error: error.message })
        throw error
      }
    },
  } as ToolDefinition
}

const summary = (env: SdkEnvironment, current?: string) => ({
  id: env.id,
  name: env.name ?? null,
  state: env.sandbox?.state ?? env.status,
  image: env.sandbox?.image ?? null,
  last_used_at: env.sandbox?.last_used_at ?? null,
  ...(env.template_id ? { template_id: env.template_id } : {}),
  ...(env.error ? { error: env.error } : {}),
  ...(env.id === current ? { this_chat: true } : {}),
})

/** The inline template a `sandbox_create` call describes (used when it names no template). */
export function inlineTemplate(args: Args): EnvironmentTemplateConfig | undefined {
  const config: EnvironmentTemplateConfig = {}
  const image = str(args.image)
  if (image) config.image = image
  const packages = { python: strs(args.python_packages), system: strs(args.system_packages), npm: strs(args.npm_packages) }
  if (packages.python.length + packages.system.length + packages.npm.length > 0) config.packages = packages
  const commands = strs(args.setup_commands)
  if (commands.length > 0) config.setup_commands = commands.map((command) => ({ command }))
  if (args.internet === false) config.network = { access: 'disabled' }
  return Object.keys(config).length > 0 ? config : undefined
}

/**
 * Register the sandbox tools and their approval handler on an agent scope.
 * @param agentCtx - agent-scoped Cordis context.
 * @param deps - the session owner, store, provider and environment helpers.
 */
export function mountSandboxTools(agentCtx: Context, deps: SandboxToolsDeps): void {
  const { owner, store, provider } = deps

  /** The owner's sandbox environment `id`, or a refusal naming the problem. */
  async function sandbox(id: unknown): Promise<EnvironmentRecord & { sandboxId: string; workspace: string }> {
    const record = typeof id === 'string' ? await store.environments.get(owner, id) : undefined
    if (!record) throw new ToolRefusal(`no sandbox "${String(id)}"; call sandbox_list for your sandboxes`)
    if (record.provider !== 'sandbox') throw new ToolRefusal(`"${record.id}" runs on this server, not in an isolated sandbox`)
    const sandboxId = record.provider_metadata['sandbox_id']
    const workspace = record.provider_metadata['workspace_directory'] ?? ''
    if (!sandboxId) throw new ToolRefusal(`this sandbox failed to set up${record.error ? `: ${record.error}` : ''}. Delete it with sandbox_delete and create it again`)
    return { ...record, sandboxId, workspace }
  }

  async function all(): Promise<EnvironmentRecord[]> {
    const out: EnvironmentRecord[] = []
    let after: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const res = await store.environments.list(owner, { limit: 100, ...(after ? { after } : {}) })
      out.push(...res.data.filter((r) => r.provider === 'sandbox'))
      if (!res.has_more || !res.last_id) break
      after = res.last_id
    }
    return out
  }

  const tools: ToolDefinition[] = [
    tool('sandbox_list', 'List the user\'s isolated sandboxes (Linux containers) with their state. `this_chat` marks the one this chat runs in, if any.', object({}), async () =>
      ({ sandboxes: await Promise.all((await all()).map(async (r) => summary(await deps.describe(r), deps.currentEnvironmentId))) })),

    tool('sandbox_templates', 'List the user\'s saved sandbox templates (setups to create a sandbox from).', object({}), async () => {
      const page = await store.templates.list(owner, { limit: 100 })
      return {
        templates: page.data.filter((t) => t.provider === 'sandbox').map((t) => ({
          id: t.id,
          name: t.name || null,
          image: t.config.image ?? null,
          packages: Array.isArray(t.config.packages) ? { system: t.config.packages } : (t.config.packages ?? {}),
          setup_commands: (t.config.setup_commands ?? []).map((c) => c.command),
          internet: t.config.network?.access !== 'disabled',
        })),
      }
    }),

    tool(
      'sandbox_create',
      'Create a new isolated sandbox (a Linux container where you are `agent` with sudo, internet access but no private networks). The user is asked to approve it. Use it to try something risky or that needs its own software, separate from this chat\'s workspace; then run commands in it with sandbox_exec. Name a template from sandbox_templates, or give the setup inline. It counts against the user\'s sandbox limits; delete it with sandbox_delete when done.',
      object({
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'Short name the user will see, such as "Scraper test".' },
        template_id: { type: 'string', description: 'A template id from sandbox_templates. Omit to describe the setup below.' },
        image: { type: 'string', description: 'Container image, such as python:3.13. Omit for the standard image (Debian with Python 3.11, Node 24, pandas, git).' },
        python_packages: { type: 'array', items: { type: 'string' } },
        system_packages: { type: 'array', items: { type: 'string' }, description: 'apt or apk packages.' },
        npm_packages: { type: 'array', items: { type: 'string' } },
        setup_commands: { type: 'array', items: { type: 'string' }, description: 'Commands run once, in order, in the workspace.' },
        internet: { type: 'boolean', description: 'false blocks all outbound traffic. Default true.' },
      }, ['name']),
      async (args) => {
        const templateId = str(args.template_id)
        const inline = templateId ? undefined : inlineTemplate(args)
        const env = await deps.provision({ provider: 'sandbox', name: str(args.name) ?? 'Sandbox', ...(templateId ? { template_id: templateId } : {}) }, inline)
        if (env.status === 'failed') return { error: env.error ?? 'the sandbox could not be created', id: env.id }
        return summary(env)
      },
    ),

    tool('sandbox_start', 'Start a stopped sandbox. Files and installed software are kept.', object(ID, ['id']), async (args) => {
      const r = await sandbox(args.id)
      await provider.api(owner).start(r.sandboxId)
      return summary(await deps.describe(r))
    }),

    tool('sandbox_stop', 'Stop a running sandbox to free resources. Files and installed software are kept; sandbox_start or sandbox_exec starts it again.', object(ID, ['id']), async (args) => {
      const r = await sandbox(args.id)
      if (r.id === deps.currentEnvironmentId) throw new ToolRefusal('that is the sandbox this chat runs in; it stops by itself when idle')
      await provider.api(owner).stop(r.sandboxId)
      return summary(await deps.describe(r))
    }),

    tool(
      'sandbox_exec',
      'Run a shell command in one of the user\'s sandboxes (as `agent`, in its workspace, with bash). A stopped sandbox starts first. Returns the exit code and the end of stdout and stderr. For this chat\'s own environment use your normal tools instead.',
      object({
        ...ID,
        command: { type: 'string', minLength: 1, description: 'Shell command or script.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Default 120.' },
      }, ['id', 'command']),
      async (args) => {
        const r = await sandbox(args.id)
        const command = str(args.command)
        if (!command) throw new ToolRefusal('command is empty')
        const seconds = typeof args.timeout_seconds === 'number' ? Math.min(600, Math.max(1, Math.floor(args.timeout_seconds))) : 120
        const res = await runInEnvd(provider.api(owner).envd(r.sandboxId), 'agent', command, { cwd: r.workspace, timeoutMs: seconds * 1000 })
        const out = tail(res.stdout, OUT_MAX)
        const err = tail(res.stderr, ERR_MAX)
        return { exit_code: res.code, stdout: out.text, stderr: err.text, ...(out.cut || err.cut ? { truncated: true } : {}) }
      },
    ),

    tool('sandbox_delete', 'Delete a sandbox and every file in it (also one that failed to set up). The user is asked to approve it. The sandbox this chat runs in cannot be deleted from here.', object(ID, ['id']), async (args) => {
      const r = typeof args.id === 'string' ? await store.environments.get(owner, args.id) : undefined
      if (!r) throw new ToolRefusal(`no sandbox "${String(args.id)}"; call sandbox_list for your sandboxes`)
      if (r.provider !== 'sandbox') throw new ToolRefusal(`"${r.id}" runs on this server, not in an isolated sandbox`)
      if (r.id === deps.currentEnvironmentId) throw new ToolRefusal('that is the sandbox this chat runs in; delete it from the Sandboxes page instead')
      await deps.destroy(r)
      await store.environments.delete(owner, r.id)
      return { id: r.id, deleted: true }
    }),
  ]
  for (const definition of tools) agentCtx.tools.register(definition)

  // Creating and deleting need the user's approval; the approval bridge turns this into a required action.
  if (typeof (agentCtx as { on?: unknown }).on !== 'function') return
  const approve = async (exec: { name: string; arguments: unknown }, next: () => Promise<unknown>): Promise<unknown> => {
    if (!ASK_TOOLS.has(exec.name)) return next()
    const args = (exec.arguments ?? {}) as Args
    let text: string
    if (exec.name === 'sandbox_create') {
      const setup = [
        str(args.template_id) ? `template ${String(args.template_id)}` : str(args.image) ? `image ${String(args.image)}` : 'standard image',
        ...[...strs(args.python_packages), ...strs(args.system_packages), ...strs(args.npm_packages)].slice(0, 6),
        ...(args.internet === false ? ['no internet'] : []),
      ]
      text = `Create sandbox "${str(args.name) ?? 'Sandbox'}" (${setup.join(', ')})`
    } else {
      const record = typeof args.id === 'string' ? await store.environments.get(owner, args.id).catch(() => undefined) : undefined
      text = `Delete sandbox "${record?.provider_metadata['name'] ?? String(args.id ?? '')}" and all its files`
    }
    return { kind: 'ask' as const, reason: text, displayReason: { en: text } }
  }
  agentCtx.on('tools/pre-execute', approve as never)
}
