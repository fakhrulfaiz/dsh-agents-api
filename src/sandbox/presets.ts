/**
 * Per-sandbox agent presets. A session on an Agentry Sandbox environment runs
 * the `agentry` preset's rows inside one isolated group whose execution
 * services (fs, subprocess, shell, sandbox, sandboxPolicy, workingDirectory,
 * ptcRuntime, terminals) come from `@agentry/api/sandbox-runtime`, so every
 * tool of that session acts inside the sandbox. One registration
 * (`agentry-sbx-<sandboxId>`) serves every session on the sandbox; it is
 * reference-counted and unregistered a grace period after the last release,
 * or at once when the environment is deleted.
 */
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

export type PresetRow = Record<string, unknown>

/** A sandbox session's preset could not start (service unreachable, sandbox cannot start). */
export class SandboxStartError extends Error {
  override name = 'SandboxStartError'
}

/** The SandboxStartError in `error` or its cause chain. */
export function sandboxStartErrorIn(error: unknown): SandboxStartError | undefined {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth += 1) {
    if (e instanceof SandboxStartError) return e
  }
  return undefined
}

/** Isolated service slots of a sandbox preset's group. */
export const SANDBOX_ISOLATED = ['ssh', 'subprocess', 'shell', 'fs', 'workingDirectory', 'sandbox', 'sandboxPolicy', 'ptcRuntime', 'terminals'] as const

export const sandboxPresetId = (sandboxId: string) => `agentry-sbx-${sandboxId}`

const CREDENTIALS = Symbol.for('agentry.sandbox.credentials')

/** Server-side Agentry Sandbox credentials for `@agentry/api/sandbox-runtime` (kept out of preset rows). */
export function setSandboxCredentials(credentials: { url: string; key: string } | undefined): void {
  ;(globalThis as Record<symbol, unknown>)[CREDENTIALS] = credentials
}
/** What to refresh inside a sandbox whenever its helper (re)starts — the API copies skills here. */
export function setSandboxPrepare(prepare: ((owner: string, sandboxId: string) => Promise<void>) | undefined): void {
  ;(globalThis as Record<symbol, unknown>)[Symbol.for('agentry.sandbox.prepare')] = prepare
}
export function sandboxCredentials(): { url: string; key: string } | undefined {
  return (globalThis as Record<symbol, unknown>)[CREDENTIALS] as { url: string; key: string } | undefined
}

/** The `agentry` preset's plugin rows from a `cordis.patch.yml`, with `!!js` kept as loader expressions. */
export function agentryPresetRows(patchPath: string): PresetRow[] {
  const customTags = [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ __jsExpr: source }) }]
  const doc = parse(readFileSync(patchPath, 'utf8'), { customTags }) as Array<{ insert?: Array<{ id?: string; config?: { plugins?: PresetRow[] } }> }>
  for (const entry of doc) {
    for (const row of entry.insert ?? []) {
      if (row.id === 'preset-agentry' && Array.isArray(row.config?.plugins)) return row.config.plugins
    }
  }
  throw new Error(`no preset-agentry rows in ${patchPath}`)
}

/** The sandbox preset's rows: the agentry rows inside one isolated group with the sandbox runtime. */
export function sandboxPresetRows(base: readonly PresetRow[], sandbox: { owner: string; sandboxId: string; workspace: string }): PresetRow[] {
  return [{
    id: 'agentry-sandbox',
    name: 'cordis:group',
    group: true,
    isolate: Object.fromEntries(SANDBOX_ISOLATED.map((k) => [k, true])),
    config: [
      { id: 'agentry-sbx-policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: sandbox.workspace } },
      { id: 'agentry-sbx-runtime', name: '@agentry/api/sandbox-runtime', config: { owner: sandbox.owner, sandboxId: sandbox.sandboxId, workspace: sandbox.workspace } },
      { id: 'agentry-sbx-working-directory', name: '@deepseek-ai/dsh-working-directory' },
      { id: 'agentry-sbx-bash', name: '@deepseek-ai/dsh-bash-sandbox', config: { timeoutMs: 60000 } },
      ...base,
    ],
  }]
}

export interface PresetRegistryLike {
  register(definition: { id: string; name?: string; description?: string; order?: number; plugins: readonly PresetRow[] }): Promise<() => Promise<void>>
  /** DSH reports a preset whose activation failed as `broken` (a mount failure is final). */
  resolve?(id: string): Promise<{ id: string; broken?: unknown }>
}

export interface SandboxPresetsOptions {
  presets: () => PresetRegistryLike | undefined
  rows: () => readonly PresetRow[]
  graceMs?: number
  /** Runs once per registration, before it is used (e.g. copying skills into the sandbox). */
  prepare?: (sandbox: { owner: string; sandboxId: string; workspace: string }) => Promise<void>
}

export interface SandboxPresetLease extends AsyncDisposable {
  presetId: string
}

interface Entry {
  refs: number
  ready: Promise<() => Promise<void>>
  timer?: NodeJS.Timeout
}

export function createSandboxPresets(opts: SandboxPresetsOptions) {
  const entries = new Map<string, Entry>()
  const grace = opts.graceMs ?? 5 * 60_000

  async function drop(sandboxId: string, entry: Entry): Promise<void> {
    if (entries.get(sandboxId) === entry) entries.delete(sandboxId)
    if (entry.timer) clearTimeout(entry.timer)
    const unregister = await entry.ready.catch(() => undefined)
    await unregister?.()
  }

  return {
    /** Holds `agentry-sbx-<sandboxId>` registered until the lease is disposed (plus the grace period). */
    async acquire(owner: string, sandboxId: string, workspace: string): Promise<SandboxPresetLease> {
      const presetId = sandboxPresetId(sandboxId)
      let entry = entries.get(sandboxId)
      if (!entry) {
        const registry = opts.presets()
        if (!registry) throw new Error('this deployment has no agent preset registry, so sandbox sessions cannot run')
        const sandbox = { owner, sandboxId, workspace }
        const created: Entry = {
          refs: 0,
          ready: (async () => {
            await opts.prepare?.(sandbox)
            const unregister = await registry.register({ id: presetId, name: 'Agentry (sandbox)', order: 1000, plugins: sandboxPresetRows(opts.rows(), sandbox) })
            const state = await registry.resolve?.(presetId)
            if (state?.broken !== undefined) {
              await unregister()
              const reason = typeof state.broken === 'string' ? state.broken : JSON.stringify(state.broken)
              throw new SandboxStartError(`the sandbox could not start: ${reason}`)
            }
            return unregister
          })(),
        }
        entries.set(sandboxId, created)
        created.ready.catch(() => { if (entries.get(sandboxId) === created) entries.delete(sandboxId) })
        entry = created
      }
      const held = entry
      held.refs += 1
      if (held.timer) { clearTimeout(held.timer); delete held.timer }
      try {
        await held.ready
      } catch (e) {
        held.refs -= 1
        throw e
      }
      let released = false
      return {
        presetId,
        async [Symbol.asyncDispose]() {
          if (released) return
          released = true
          held.refs -= 1
          if (held.refs > 0 || entries.get(sandboxId) !== held) return
          held.timer = setTimeout(() => { void drop(sandboxId, held) }, grace)
          held.timer.unref()
        },
      }
    },

    /** Unregisters a sandbox's preset now (its environment was deleted); live sessions fail their next tool call. */
    async evict(sandboxId: string): Promise<void> {
      const entry = entries.get(sandboxId)
      if (entry) await drop(sandboxId, entry)
    },

    /** Registered sandbox ids (tests and diagnostics). */
    registered: () => [...entries.keys()],

    async dispose(): Promise<void> {
      await Promise.all([...entries].map(([id, e]) => drop(id, e)))
    },
  }
}

export type SandboxPresets = ReturnType<typeof createSandboxPresets>
