/**
 * The `sandbox` environment provider: environments that live in the Agentry
 * Sandbox service (Docker now, other backends later).
 *
 * A sandbox's workspace disk mounts at `/workspace` inside it. The folder need
 * not exist on this host: a sandbox session's working directory is checked
 * inside the sandbox (src/working-directory.ts). A sandbox on a shared machine
 * (an ssh-machine place) mounts at its unique path
 * `<workspacesRoot>/<owner>/sandbox-<envId>` instead (an empty placeholder of
 * that name is kept on this host). Files are read and written through envd
 * (as `agent`).
 */
import { mkdir, rmdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Readable } from 'node:stream'
import { createSandboxApi, SandboxApiError, type SandboxApi, type WireBackend, type WireSandbox, type WireSnapshot, type WireSnapshotLevel, type WireTemplate } from '@agentry/sandbox/client'
import type { OwnerId } from '../auth/authenticator.ts'
import { directorySegment } from '../environment/local.ts'
import type { CreateEnvironmentInput, EnvironmentCreateResult } from '../environment/provider.ts'
import type { EnvironmentRecord, EnvironmentStatus, EnvironmentTemplateConfig } from '../environment-types.ts'
import type { SandboxProgress, SandboxSummary } from '../environment/environment-compat.ts'
import type { SandboxProvider } from './contract.ts'

export interface AgentrySandboxOptions {
  url: string
  key: string
  workspacesRoot: string
  /** The in-sandbox workspace path (default `/workspace`). Sandboxes on a shared machine (an ssh-machine place) use their unique host placeholder path instead. */
  sharedWorkspace?: string
}

export interface AgentrySandboxProvider extends SandboxProvider {
  /** Whether the service answers and accepts the key, with the reason when not. */
  availability(): Promise<{ available: true; version: string; default_image?: WireBackend['default_image']; places: SandboxPlaceRow[] } | { available: false; reason: string; places: SandboxPlaceRow[] }>
  /** The service client for one owner (start, stop, reset, envd). */
  api(owner: string): SandboxApi
  /** The service's download of a files-only snapshot, as the raw response (stream it; do not buffer). Throws SandboxApiError on a refusal. */
  downloadSnapshot(owner: string, snapshotId: string, signal?: AbortSignal): Promise<Response>
  /**
   * Sends a request to a port inside the sandbox through the service and answers the raw response, whatever its status
   * (stream it; do not buffer). Throws SandboxApiError only when the service cannot be reached.
   */
  proxyPort(owner: string, sandboxId: string, port: number, target: string, init: { method: string; headers: Record<string, string>; body?: Readable; signal?: AbortSignal }): Promise<Response>
  /** Streams an archive to the service as a new files-only snapshot; answers the snapshot. Throws SandboxApiError on a refusal. */
  importSnapshot(owner: string, body: Readable, opts: { name?: string; contentLength?: number; signal?: AbortSignal }): Promise<WireSnapshot>
  /** Workspace files with size and modification time, skipping `.git` and `node_modules` (at most 5000). */
  listEntries(record: EnvironmentRecord): Promise<WorkspaceEntry[]>
  /** Watch workspace changes; yields batches of workspace-relative paths. */
  watch(record: EnvironmentRecord, signal: AbortSignal): AsyncIterable<string[]>
  /** Whether a workspace-relative path exists in the sandbox. */
  /**
   * After a create that timed out client-side: find the sandbox the service made for it (same name, created since
   * `sinceSeconds`, newest first). `undefined` when the service has none.
   */
  adopt(owner: OwnerId, environmentId: string, input: CreateEnvironmentInput, sinceSeconds: number): Promise<EnvironmentCreateResult | undefined>
  /** Live state, image and last use for the environment wire object. Never throws. */
  describe(record: EnvironmentRecord): Promise<SandboxSummary>
  /** Size of a workspace file, or `undefined` when there is no such file. */
  fileSize(record: EnvironmentRecord, path: string): Promise<number | undefined>
  /** Size and modification time (ms) of a workspace file, or `undefined` when there is no such file. */
  fileStat(record: EnvironmentRecord, path: string): Promise<{ size: number; mtimeMs: number } | undefined>
  exists(record: EnvironmentRecord, path: string): Promise<boolean>
  /** Remove a workspace-relative file in the sandbox (missing is not an error). */
  remove(record: EnvironmentRecord, path: string): Promise<void>
  /** The absolute path of a workspace-relative path in the sandbox. */
  absolute(record: EnvironmentRecord, path: string): string
  /** Run a `/bin/sh -c` script as `agent` (default 30 s; stdout and stderr capped at 8 MB each, `truncated` when cut). */
  exec(record: EnvironmentRecord, script: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ code: number; stdout: string; stderr: string; truncated?: boolean }>
  /** The workspace directory inside the sandbox. */
  workspaceDir(record: EnvironmentRecord): string
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
  /** The snapshot levels a sandbox here can take (the service's `snapshots`; empty when none). */
  snapshot_levels: WireSnapshotLevel[]
}

export interface WorkspaceEntry {
  path: string
  size: number
  last_modified: string
}

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const MAX_ENTRIES = 5000
const UPLOADS = 'uploads'

/** Workspace-relative watch path, or `undefined` when the event should be ignored. */
export function normalizeSandboxWatchPath(dir: string, name: string): string | undefined {
  const raw = name.replace(/\\/g, '/')
  const abs = raw.startsWith('/') ? raw : posix.join(dir, raw)
  const rel = posix.relative(dir, abs)
  if (!rel || rel === '.' || rel.startsWith('..')) return undefined
  if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) return undefined
  return rel
}

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
const EXEC_TIMEOUT_MS = 30_000
const EXEC_OUTPUT_CAP = 8 * 1024 * 1024
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
  const serviceHeaders = (owner: string) => ({ Authorization: `Bearer ${opts.key}`, 'X-Agentry-Owner': owner })
  const serviceError = async (res: Response) => {
    const err = (await res.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined)?.error
    return new SandboxApiError(res.status, err?.code ?? 'error', err?.message ?? `Agentry Sandbox answered ${String(res.status)}`)
  }
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

    async downloadSnapshot(owner, snapshotId, signal) {
      const res = await fetch(`${opts.url.replace(/\/+$/, '')}/v1/snapshots/${encodeURIComponent(snapshotId)}/download`, { headers: serviceHeaders(owner), ...(signal ? { signal } : {}) })
      if (!res.ok) throw await serviceError(res)
      return res
    },

    async proxyPort(owner, sandboxId, port, target, init) {
      const url = `${opts.url.replace(/\/+$/, '')}/v1/sandboxes/${encodeURIComponent(sandboxId)}/ports/${String(port)}/${target}`
      try {
        return await fetch(url, {
          method: init.method,
          headers: { ...init.headers, ...serviceHeaders(owner) },
          ...(init.body ? { body: Readable.toWeb(init.body) as unknown as ReadableStream, duplex: 'half' } : {}),
          redirect: 'manual',
          ...(init.signal ? { signal: init.signal } : {}),
        } as RequestInit)
      } catch (e) {
        throw new SandboxApiError(0, 'unreachable', `Agentry Sandbox is not reachable: ${(e as Error).message}`)
      }
    },

    async importSnapshot(owner, body, o) {
      const url = `${opts.url.replace(/\/+$/, '')}/v1/snapshots/import${o.name ? `?name=${encodeURIComponent(o.name)}` : ''}`
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { ...serviceHeaders(owner), 'content-type': 'application/gzip', ...(o.contentLength !== undefined ? { 'content-length': String(o.contentLength) } : {}) },
          body: Readable.toWeb(body) as unknown as ReadableStream,
          duplex: 'half',
          ...(o.signal ? { signal: o.signal } : {}),
        } as RequestInit)
      } catch (e) {
        throw new SandboxApiError(0, 'unreachable', `Agentry Sandbox is not reachable: ${(e as Error).message}`)
      }
      if (!res.ok) throw await serviceError(res)
      return await res.json() as WireSnapshot
    },

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
          snapshot_levels: b.snapshots ?? [],
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
        const mount = (await sharesMachine(place)) ? dir : (opts.sharedWorkspace ?? '/workspace')
        const s = await api(owner).create({ name: input.name ?? environmentId, template, workspace_path: mount, ...(place ? { place } : {}), ...(input.snapshot_id ? { snapshot: input.snapshot_id } : {}) })
        return { status: statusOf(s.state), workspacePath: mount, handle: { sandbox_id: s.id, workspace_directory: mount, host_placeholder: dir, image: s.image, owner } }
      } catch (e) {
        return { status: 'failed' as const, workspacePath: dir, error: (e as Error).message }
      }
    },

    async adopt(owner: OwnerId, environmentId: string, input: CreateEnvironmentInput, sinceSeconds: number) {
      const name = input.name ?? environmentId
      let found: WireSandbox | undefined
      try {
        found = (await quickApi(owner).list())
          .filter((s) => s.name === name && s.created_at >= sinceSeconds - 5)
          .sort((a, b) => b.created_at - a.created_at)[0]
      } catch {
        return undefined
      }
      if (found === undefined) return undefined
      const dir = join(opts.workspacesRoot, directorySegment(owner, 'owner'), `sandbox-${environmentId}`)
      return { status: statusOf(found.state), workspacePath: found.workspace_path, handle: { sandbox_id: found.id, workspace_directory: found.workspace_path, host_placeholder: dir, image: found.image, owner }, ...(found.error ? { error: found.error } : {}) }
    },

    async describe(record) {
      try {
        const s = await quickApi(ownerOf(record)).get(meta(record).id)
        const progress = s.state === 'provisioning' ? (s as { progress?: SandboxProgress | null }).progress : undefined
        return { state: s.state, image: s.image, place: s.place, ...(s.gpus ? { gpus: s.gpus } : {}), started_at: s.started_at, last_used_at: s.last_used_at, ...(progress ? { progress } : {}) }
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

    watch(record, signal) {
      const { id, dir } = meta(record)
      const envd = api(ownerOf(record)).envd(id)
      const stream = envd.filesystem.watchDir({ path: dir, recursive: true }, { headers: envd.userHeaders(AGENT), signal })
      const normalize = normalizeSandboxWatchPath
      async function* iter(): AsyncIterable<string[]> {
        for await (const msg of stream) {
          if (signal.aborted) return
          if (msg.event.case !== 'filesystem') continue
          const rel = normalize(dir, msg.event.value.name)
          if (rel) yield [rel]
        }
      }
      return iter()
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

    async fileStat(record, path) {
      const { id, dir } = meta(record)
      const envd = api(ownerOf(record)).envd(id)
      try {
        const res = await envd.filesystem.stat({ path: inside(dir, path) }, { headers: envd.userHeaders(AGENT) })
        const type = String(res.entry?.type)
        if (type !== '1' && type !== 'FILE_TYPE_FILE') return undefined
        const modified = res.entry?.modifiedTime
        const mtimeMs = modified === undefined ? 0 : Number(modified.seconds) * 1000 + Math.trunc(modified.nanos / 1_000_000)
        return { size: Number(res.entry?.size ?? 0), mtimeMs }
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

    workspaceDir(record) {
      return meta(record).dir
    },

    async exec(record, script, opts = {}) {
      const { id } = meta(record)
      const envd = api(ownerOf(record)).envd(id)
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? EXEC_TIMEOUT_MS)
      const stop = new AbortController()
      const signal = AbortSignal.any([timeout, stop.signal, ...(opts.signal ? [opts.signal] : [])])
      const decoder = { out: new TextDecoder(), err: new TextDecoder() }
      let stdout = ''
      let stderr = ''
      let code = -1
      let truncated = false
      const stream = envd.process.start(
        { process: { cmd: '/bin/sh', args: ['-c', script], envs: {} }, stdin: false },
        { headers: envd.userHeaders(AGENT), signal },
      )
      try {
        for await (const res of stream) {
          const ev = res.event?.event
          if (ev?.case === 'data') {
            const out = ev.value.output
            if (out.case === 'stdout') stdout += decoder.out.decode(out.value, { stream: true })
            else if (out.case === 'stderr') stderr += decoder.err.decode(out.value, { stream: true })
            if (stdout.length > EXEC_OUTPUT_CAP || stderr.length > EXEC_OUTPUT_CAP) {
              truncated = true
              stop.abort()
              break
            }
          } else if (ev?.case === 'end') {
            code = ev.value.exitCode
          }
        }
      } catch (e) {
        if (!truncated) throw e
      }
      return { code, stdout: stdout.slice(0, EXEC_OUTPUT_CAP), stderr: stderr.slice(0, EXEC_OUTPUT_CAP), ...(truncated ? { truncated } : {}) }
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
    // What any available place can take, so a client knows whether to offer snapshots at all.
    const places = 'places' in a ? a.places : []
    const snapshot_levels = (['workspace', 'disk', 'memory'] as const).filter(l => places.some(x => x.available && x.snapshot_levels.includes(l)))
    return { object: 'sandbox.provider', name, ...rest, ...a, ...(places.length > 0 ? { snapshot_levels } : {}) }
  }))
}
