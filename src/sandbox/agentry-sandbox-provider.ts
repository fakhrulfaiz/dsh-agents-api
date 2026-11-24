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
import { createSandboxApi, SandboxApiError, type SandboxApi, type WireSandbox, type WireTemplate } from '@agentry/sandbox/client'
import type { OwnerId } from '../auth/authenticator.ts'
import { directorySegment } from '../environment/local.ts'
import type { CreateEnvironmentInput } from '../environment/provider.ts'
import type { EnvironmentRecord, EnvironmentStatus, EnvironmentTemplateConfig } from '../environment-types.ts'
import type { SandboxProvider } from './contract.ts'

export interface AgentrySandboxOptions {
  url: string
  key: string
  workspacesRoot: string
}

export interface AgentrySandboxProvider extends SandboxProvider {
  /** Whether the service answers and accepts the key, with the reason when not. */
  availability(): Promise<{ available: true; version: string } | { available: false; reason: string }>
  /** The service client for one owner (start, stop, reset, envd). */
  api(owner: string): SandboxApi
}

const AGENT = 'agent'

/** A workspace-relative path, refusing anything that would leave the workspace. */
function inside(dir: string, path: string): string {
  const rel = posix.normalize(path.replace(/\\/g, '/').replace(/^\/+/, ''))
  if (!rel || rel === '.' || rel.startsWith('..') || rel.includes('\0')) throw new Error(`invalid workspace path: ${path}`)
  return posix.join(dir, rel)
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
    ...(!Array.isArray(t.packages) && t.packages?.python?.length ? [`pip install --user ${t.packages.python.join(' ')}`] : []),
    ...(!Array.isArray(t.packages) && t.packages?.npm?.length ? [`sudo npm install -g ${t.packages.npm.join(' ')}`] : []),
  ]
  if (setup.length > 0) out.setup_commands = setup
  if (t.network) out.network = t.network.access !== 'disabled'
  const files = [...(t.starter_files ?? []), ...((t.files ?? []) as unknown as { path: string; content: string }[])].filter((f) => typeof f?.path === 'string' && typeof f.content === 'string')
  if (files.length > 0) out.files = files.map((f) => ({ path: f.path, content: f.content }))
  return out
}

const statusOf = (s: WireSandbox['state']): EnvironmentStatus => (s === 'failed' ? 'failed' : s === 'deleting' ? 'cleanup' : s === 'provisioning' ? 'pending' : 'connected')

export function createAgentrySandboxProvider(opts: AgentrySandboxOptions): AgentrySandboxProvider {
  const api = (owner: string) => createSandboxApi({ url: opts.url, key: opts.key, owner })
  const meta = (record: EnvironmentRecord) => {
    const id = record.provider_metadata['sandbox_id']
    const dir = record.provider_metadata['workspace_directory']
    if (!id || !dir) throw new Error(`environment ${record.id} has no sandbox`)
    return { id, dir }
  }
  const ownerOf = (record: EnvironmentRecord) => record.provider_metadata['owner'] ?? ''

  return {
    kind: 'sandbox',
    capabilities: { templateFields: ['image', 'packages', 'setup_commands', 'env', 'network', 'files'], files: true, exec: true },

    api,

    async availability() {
      try {
        const [backend] = await api('agentry').backends()
        if (!backend) return { available: false, reason: 'Agentry Sandbox has no backend' }
        return backend.available ? { available: true, version: backend.version ?? 'unknown' } : { available: false, reason: backend.reason ?? 'the sandbox backend is unavailable' }
      } catch (e) {
        if (e instanceof SandboxApiError && e.status === 401) return { available: false, reason: 'Agentry Sandbox refused the configured key' }
        return { available: false, reason: (e as Error).message }
      }
    },

    async create(owner: OwnerId, environmentId: string, input: CreateEnvironmentInput) {
      const dir = join(opts.workspacesRoot, directorySegment(owner, 'owner'), `sandbox-${environmentId}`)
      await mkdir(dir, { recursive: true })
      const template = toServiceTemplate(input.template)
      if (input.image) template.image = input.image
      try {
        const s = await api(owner).create({ name: environmentId, template, workspace_path: dir })
        return { status: statusOf(s.state), workspacePath: dir, handle: { sandbox_id: s.id, workspace_directory: dir, image: s.image, owner } }
      } catch (e) {
        return { status: 'failed' as const, workspacePath: dir, error: (e as Error).message }
      }
    },

    async status(record) {
      try {
        return statusOf((await api(ownerOf(record)).get(meta(record).id)).state)
      } catch {
        return 'failed'
      }
    },

    async destroy(record) {
      const { id, dir } = meta(record)
      try {
        await api(ownerOf(record)).remove(id)
      } catch (e) {
        if (!(e instanceof SandboxApiError && e.status === 404)) throw e
      }
      await rmdir(dir).catch(() => {})
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
