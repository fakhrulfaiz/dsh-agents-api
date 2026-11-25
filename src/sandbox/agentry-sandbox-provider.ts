/**
 * The `sandbox` environment provider: environments that live in the Agentry
 * Sandbox service (Docker now, other backends later).
 *
 * DSH checks a session's working directory on this host, so every sandbox
 * gets an empty placeholder directory `<workspacesRoot>/<owner>/sandbox-<envId>`
 * and the service mounts the sandbox's workspace at that same absolute path
 * inside the container: paths are identical on both sides and nothing is
 * translated. Files are read and written through envd (as `agent`).
 */
import { mkdir, rmdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { createSandboxApi, SandboxApiError, type SandboxApi, type WireBackend, type WireSandbox, type WireTemplate } from '@agentry/sandbox/client'
import type { OwnerId } from '../auth/authenticator.ts'
import { directorySegment } from '../environment/local.ts'
import type { CreateEnvironmentInput } from '../environment/provider.ts'
import type { EnvironmentRecord, EnvironmentStatus, EnvironmentTemplateConfig } from '../environment-types.ts'
import type { SandboxSummary } from '../environment/environment-compat.ts'
import type { SandboxProvider } from './contract.ts'

export interface AgentrySandboxOptions {
  url: string
  key: string
  workspacesRoot: string
}

export interface AgentrySandboxProvider extends SandboxProvider {
  /** Whether the service answers and accepts the key, with the reason when not. */
  availability(): Promise<{ available: true; version: string; default_image?: WireBackend['default_image']; places: SandboxPlaceRow[] } | { available: false; reason: string; places: SandboxPlaceRow[] }>
  /** The service client for one owner (start, stop, reset, envd). */
  api(owner: string): SandboxApi
  /** Workspace files with size and modification time, skipping `.git` and `node_modules` (at most 5000). */
  listEntries(record: EnvironmentRecord): Promise<WorkspaceEntry[]>
  /** Whether a workspace-relative path exists in the sandbox. */
  /** Live state, image and last use for the environment wire object. Never throws. */
  describe(record: EnvironmentRecord): Promise<SandboxSummary>
  /** Size of a workspace file, or `undefined` when there is no such file. */
  fileSize(record: EnvironmentRecord, path: string): Promise<number | undefined>
  exists(record: EnvironmentRecord, path: string): Promise<boolean>
  /** Remove a workspace-relative file in the sandbox (missing is not an error). */
  remove(record: EnvironmentRecord, path: string): Promise<void>
  /** The absolute path of a workspace-relative path in the sandbox. */
  absolute(record: EnvironmentRecord, path: string): string
}

/** One Agentry Sandbox place as listed on the `sandbox` provider row. */
export interface SandboxPlaceRow {
  id: string
  name: string
  kind: string
  default: boolean
  available: boolean
  reason?: string
  gpus?: { count: number; models: string[] }
  capabilities: { reset: boolean; keepFilesOnReset: boolean; isolated: boolean; gpu: boolean }
}

export interface WorkspaceEntry {
  path: string
  size: number
  last_modified: string
}

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const MAX_ENTRIES = 5000
const UPLOADS = 'uploads'

/** `name-N.ext` for the Nth retry. */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}-${String(n)}${name.slice(dot)}` : `${name}-${String(n)}`
}

/**
 * Write an upload to `uploads/<name>` in a sandbox workspace, never overwriting
 * (`name-1.ext`, `name-2.ext`, ...), like the host's copyIntoUploads.
 */
export async function copyIntoSandboxUploads(
  provider: AgentrySandboxProvider, record: EnvironmentRecord, name: string, source: AsyncIterable<Uint8Array>,
): Promise<{ relative: string; absolute: string; remove?: () => Promise<void> }> {
  const parts: Uint8Array[] = []
  for await (const chunk of source) parts.push(chunk)
  const bytes = Buffer.concat(parts)
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const relative = `${UPLOADS}/${attempt === 0 ? name : numbered(name, attempt)}`
    if (await provider.exists(record, relative)) continue
    await provider.writeFile(record, relative, bytes)
    return { relative, absolute: provider.absolute(record, relative), remove: () => provider.remove(record, relative) }
  }
  throw new Error(`Could not find a free name for "${name}" in uploads/`)
}

const AGENT = 'agent'
const QUICK_TIMEOUT_MS = 10_000
/** Largest artifact served from a sandbox in one response. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

/** A workspace-relative path, refusing anything that would leave the workspace. */
function inside(dir: string, path: string): string {
  const rel = posix.normalize(path.replace(/\\/g, '/').replace(/^\/+/, ''))
  if (!rel || rel === '.' || rel.startsWith('..') || rel.includes('\0')) throw new Error(`invalid workspace path: ${path}`)
  return posix.join(dir, rel)
}

/** Installs Python packages for `agent`, on images whose Python is externally managed (Debian 12) and on older pip alike. */
export function pipInstall(packages: string[]): string {
  const list = packages.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ')
  return `python3 -m pip install --user --break-system-packages ${list} || python3 -m pip install --user ${list}`
}

/** The OpenAI-shaped template as the service's template (packages by kind, setup commands in order). */
export function toServiceTemplate(t: EnvironmentTemplateConfig | undefined): WireTemplate {
  if (!t) return {}
  const out: WireTemplate = {}
  if (t.image) out.image = t.image
  if (t.env ?? t.default_env) out.env = { ...t.default_env, ...t.env }
  const system = Array.isArray(t.packages) ? t.packages : (t.packages?.system ?? [])
  if (system.length > 0) out.packages = system
  const setup = [
    ...(t.setup ? [t.setup] : []),
    ...(t.setup_commands ?? []).map((c) => (c.cwd ? `cd ${JSON.stringify(c.cwd)} && ${c.command}` : c.command)),
    // Debian 12's Python is "externally managed": --user installs need --break-system-packages (older pip lacks the flag).
    ...(!Array.isArray(t.packages) && t.packages?.python?.length ? [pipInstall(t.packages.python)] : []),
    ...(!Array.isArray(t.packages) && t.packages?.npm?.length ? [`sudo npm install -g ${t.packages.npm.join(' ')}`] : []),
  ]
  if (setup.length > 0) out.setup_commands = setup
  if (t.network) out.network = t.network.access !== 'disabled'
  if (t.resources !== undefined) out.resources = { ...t.resources }
  if (t.place) out.place = t.place
  if (t.gpus !== undefined) out.gpus = t.gpus
  // Template files are base64 (`inline`); `file_id` files need the Files API and are not applied here.
  // `/workspace/...` (the SDK's workspace) lands in the sandbox's real workspace.
  const inWorkspace = (path: string) => (path === '/workspace' || path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : path)
  const files = [
    ...(t.starter_files ?? []).map((f) => ({ path: f.path, content: f.content })),
    ...(t.files ?? []).flatMap((f) => (f.type === 'inline' ? [{ path: f.path, content: Buffer.from(f.data, 'base64').toString('utf8') }] : [])),
  ].filter((f) => typeof f.path === 'string' && inWorkspace(f.path) !== '')
  if (files.length > 0) out.files = files.map((f) => ({ path: inWorkspace(f.path), content: f.content }))
  return out
}

const statusOf = (s: WireSandbox['state']): EnvironmentStatus => (s === 'failed' ? 'failed' : s === 'deleting' ? 'cleanup' : s === 'provisioning' ? 'pending' : 'connected')

export function createAgentrySandboxProvider(opts: AgentrySandboxOptions): AgentrySandboxProvider {
  const api = (owner: string) => createSandboxApi({ url: opts.url, key: opts.key, owner })
  // Status and availability are read on page loads: answer within seconds, not the 180 s create budget.
  const quickApi = (owner: string) => createSandboxApi({ url: opts.url, key: opts.key, owner, timeoutMs: QUICK_TIMEOUT_MS })
  const meta = (record: EnvironmentRecord) => {
    const id = record.provider_metadata['sandbox_id']
    const dir = record.provider_metadata['workspace_directory']
    if (!id || !dir) throw new Error(`environment ${record.id} has no sandbox`)
    return { id, dir }
  }
  const ownerOf = (record: EnvironmentRecord) => record.provider_metadata['owner'] ?? ''

  /** True when `place` (or the default place) is a shared machine, whose sandboxes need distinct workspace paths. */
  async function sharesMachine(place: string | undefined): Promise<boolean> {
    try {
      const backends = await quickApi('agentry').backends()
      const chosen = place ? backends.find((b) => b.id === place) : (backends.find((b) => b.default) ?? backends[0])
      return chosen?.kind === 'ssh-machine'
    } catch {
      // Cannot tell: the unique long path works everywhere.
      return true
    }
  }

  return {
    kind: 'sandbox',
    capabilities: { templateFields: ['image', 'packages', 'setup_commands', 'env', 'network', 'files', 'resources', 'gpus'], files: true, exec: true },

    api,

    async availability() {
      try {
        const backends = await quickApi('agentry').backends()
        const places: SandboxPlaceRow[] = backends.map((b) => ({
          id: b.id,
          name: b.name,
          kind: b.kind,
          default: b.default,
          available: b.available,
          ...(b.available ? {} : { reason: b.reason ?? 'the place is unavailable' }),
          ...(b.gpus ? { gpus: b.gpus } : {}),
          capabilities: { reset: b.capabilities.reset, keepFilesOnReset: b.capabilities.keepFilesOnReset, isolated: b.capabilities.isolated, gpu: b.capabilities.gpu },
        }))
        const main = backends.find((b) => b.default) ?? backends[0]
        if (!main) return { available: false, reason: 'Agentry Sandbox has no place', places }
        const up = backends.find((b) => b.available)
        if (!up) return { available: false, reason: main.reason ?? 'the sandbox place is unavailable', places }
        return { available: true, version: (main.available ? main : up).version ?? 'unknown', ...(main.default_image ? { default_image: main.default_image } : {}), places }
      } catch (e) {
        if (e instanceof SandboxApiError && e.status === 401) return { available: false, reason: 'Agentry Sandbox refused the configured key', places: [] }
        return { available: false, reason: (e as Error).message, places: [] }
      }
    },

    async create(owner: OwnerId, environmentId: string, input: CreateEnvironmentInput) {
      // The host placeholder is kept (cleaned up on delete); the disk itself mounts at /workspace so the model, the
      // terminal and the tools all see one short path. A shared machine (ssh-machine) needs a unique mount path per sandbox.
      const dir = join(opts.workspacesRoot, directorySegment(owner, 'owner'), `sandbox-${environmentId}`)
      await mkdir(dir, { recursive: true })
      const template = toServiceTemplate(input.template)
      if (input.image) template.image = input.image
      try {
        const place = input.place ?? input.template?.place
        const mount = (await sharesMachine(place)) ? dir : '/workspace'
        const s = await api(owner).create({ name: input.name ?? environmentId, template, workspace_path: mount, ...(place ? { place } : {}) })
        return { status: statusOf(s.state), workspacePath: mount, handle: { sandbox_id: s.id, workspace_directory: mount, host_placeholder: dir, image: s.image, owner } }
      } catch (e) {
        return { status: 'failed' as const, workspacePath: dir, error: (e as Error).message }
      }
    },

    async describe(record) {
      try {
        const s = await quickApi(ownerOf(record)).get(meta(record).id)
        return { state: s.state, image: s.image, place: s.place, ...(s.gpus ? { gpus: s.gpus } : {}), started_at: s.started_at, last_used_at: s.last_used_at }
      } catch (e) {
        return { state: e instanceof SandboxApiError && e.status === 404 ? 'gone' : 'unknown', ...(record.provider_metadata['image'] ? { image: record.provider_metadata['image'] } : {}) }
      }
    },

    async status(record) {
      try {
        return statusOf((await quickApi(ownerOf(record)).get(meta(record).id)).state)
      } catch (e) {
        // Gone is failed; a transient outage keeps the last known status instead of flipping to failed.
        if (e instanceof SandboxApiError && e.status === 404) return 'failed'
        if (e instanceof SandboxApiError && (e.code === 'unreachable' || e.status >= 500)) return record.status
        return 'failed'
      }
    },

    async destroy(record) {
      // An environment whose sandbox was never created (its create failed) has only the host placeholder to remove.
      if (!record.provider_metadata['sandbox_id']) {
        const dir = record.provider_metadata['host_placeholder'] ?? record.provider_metadata['workspace_directory']
        if (dir) await rmdir(dir).catch(() => {})
        return
      }
      const { id, dir } = meta(record)
      try {
        await api(ownerOf(record)).remove(id)
      } catch (e) {
        if (!(e instanceof SandboxApiError && e.status === 404)) throw e
      }
      await rmdir(record.provider_metadata['host_placeholder'] ?? dir).catch(() => {})
    },

    async listFiles(record) {
      const { id, dir } = meta(record)
      const envd = api(ownerOf(record)).envd(id)
      const res = await envd.filesystem.listDir({ path: dir, depth: 64 }, { headers: envd.userHeaders(AGENT) })
      return res.entries
        .filter((e) => String(e.type) === '1' || (e.type as unknown) === 'FILE_TYPE_FILE')
        .map((e) => posix.relative(dir, e.path))
        .filter((p) => p && !p.startsWith('..'))
        .sort()
    },

    async listEntries(record) {
      const { id, dir } = meta(record)
      const envd = api(ownerOf(record)).envd(id)
      const out: WorkspaceEntry[] = []
      const queue = [dir]
      while (queue.length > 0 && out.length < MAX_ENTRIES) {
        const at = queue.shift()!
        const res = await envd.filesystem.listDir({ path: at, depth: 1 }, { headers: envd.userHeaders(AGENT) }).catch(() => undefined)
        for (const e of res?.entries ?? []) {
          const type = String(e.type)
          if (type === '2' || type === 'FILE_TYPE_DIRECTORY') {
            if (!SKIP_DIRS.has(e.name)) queue.push(e.path)
          } else if (type === '1' || type === 'FILE_TYPE_FILE') {
            const rel = posix.relative(dir, e.path)
            if (!rel || rel.startsWith('..')) continue
            const seconds = e.modifiedTime?.seconds
            out.push({ path: rel, size: Number(e.size), last_modified: new Date(seconds === undefined ? 0 : Number(seconds) * 1000).toISOString() })
            if (out.length >= MAX_ENTRIES) break
          }
        }
      }
      return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },

    async fileSize(record, path) {
      const { id, dir } = meta(record)
      const envd = api(ownerOf(record)).envd(id)
      try {
        const res = await envd.filesystem.stat({ path: inside(dir, path) }, { headers: envd.userHeaders(AGENT) })
        const type = String(res.entry?.type)
        return type === '1' || type === 'FILE_TYPE_FILE' ? Number(res.entry?.size ?? 0) : undefined
      } catch (e) {
        if ((e as { code?: unknown }).code === 5 || /not[_ ]found|no such file/i.test((e as Error).message)) return undefined
        throw e
      }
    },

    async exists(record, path) {
      const { id, dir } = meta(record)
      const envd = api(ownerOf(record)).envd(id)
      try {
        await envd.filesystem.stat({ path: inside(dir, path) }, { headers: envd.userHeaders(AGENT) })
        return true
      } catch (e) {
        if ((e as { code?: unknown }).code === 5 || /not[_ ]found|no such file/i.test((e as Error).message)) return false
        throw e
      }
    },

    async remove(record, path) {
      const { id, dir } = meta(record)
      const envd = api(ownerOf(record)).envd(id)
      await envd.filesystem.remove({ path: inside(dir, path) }, { headers: envd.userHeaders(AGENT) }).catch(() => {})
    },

    absolute(record, path) {
      return inside(meta(record).dir, path)
    },

    async readFile(record, path) {
      const { id, dir } = meta(record)
      return api(ownerOf(record)).envd(id).readFile(inside(dir, path), AGENT)
    },

    async writeFile(record, path, content) {
      const { id, dir } = meta(record)
      await api(ownerOf(record)).envd(id).writeFile(inside(dir, path), content, AGENT)
    },
  }
}

/** Rows for `GET /agents/environments/providers`: every provider, with availability where it can tell. */
export async function providerRows(registry: { list(): { name: string; capabilities: unknown; default: boolean }[]; get(kind: string): unknown }) {
  return Promise.all(registry.list().map(async ({ name, ...rest }) => {
    const p = registry.get(name) as Partial<AgentrySandboxProvider> | undefined
    const a = typeof p?.availability === 'function' ? await p.availability() : { available: true as const }
    return { object: 'sandbox.provider', name, ...rest, ...a }
  }))
}
