/**
 * Environment templates, live Codebox records, and session attach.
 *
 * No Codebox client creates a local directory instead of a sandbox. Disk writes are
 * optional; sessions themselves stay in memory.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { sanitizeRelativePath } from './artifacts.ts'
import type { CodeboxClient, CodeboxSettings } from './codebox-client.ts'
import type { FsEnvironmentApiStore } from './durable-store.ts'
import type {
  EnvironmentRecord,
  EnvironmentStatus,
  EnvironmentTemplate,
  EnvironmentTemplateConfig,
} from './environment-types.ts'

/** Fields copied onto a new live environment. */
export interface CreateEnvironmentInput {
  template_id?: string
  session_id?: string
  image?: string
  provision?: boolean
}

/** Resolved session environment plus the codebox id to attach, when connected. */
export interface ResolvedSessionEnvironment {
  environment: { type: 'sandbox'; environment_id: string }
  codeboxId?: string
}

/**
 * In-memory environment directory with optional JSON write-through.
 */
export class EnvironmentDirectory {
  readonly templates = new Map<string, EnvironmentTemplate>()
  readonly environments = new Map<string, EnvironmentRecord>()
  readonly #codebox: CodeboxClient | undefined
  readonly #image: string
  readonly #readyTimeoutSeconds: number
  readonly #budgetInstanceId: string
  readonly #localRoot: string
  #disk: FsEnvironmentApiStore | undefined
  #pending: Promise<void> = Promise.resolve()

  /**
   * @param codebox - Codebox client when configured.
   * @param settings - image and wait budget used during provision.
   * @param localRoot - directory for environments created without Codebox.
   */
  constructor(codebox?: CodeboxClient, settings: Partial<CodeboxSettings> = {}, localRoot?: string) {
    this.#codebox = codebox
    this.#image = settings.image ?? 'base'
    this.#readyTimeoutSeconds = settings.readyTimeoutSeconds ?? 120
    this.#budgetInstanceId = settings.budgetInstanceId ?? ''
    this.#localRoot = localRoot ?? join(tmpdir(), 'agents-api-environments')
  }

  /**
   * Load template and environment files, then write later mutations through.
   * @param disk - filesystem store.
   */
  async openDisk(disk: FsEnvironmentApiStore): Promise<void> {
    this.#disk = disk
    for (const template of await disk.loadTemplates()) this.templates.set(template.id, template)
    for (const env of await disk.loadEnvironments()) this.environments.set(env.id, env)
  }

  /** Wait until queued disk writes finish. */
  async settled(): Promise<void> {
    await this.#pending
  }

  /**
   * Save a template.
   * @param input - name and optional Codebox blueprint.
   */
  createTemplate(input: { name: string; config?: EnvironmentTemplateConfig }): EnvironmentTemplate {
    const now = Math.floor(Date.now() / 1000)
    const template: EnvironmentTemplate = {
      id: `tpl_${randomUUID().replaceAll('-', '')}`,
      object: 'environment.template',
      name: input.name,
      provider: 'codebox',
      config: input.config ?? {},
      created_at: now,
    }
    this.templates.set(template.id, template)
    this.#enqueue(() => this.#disk?.putTemplate(template))
    return template
  }

  /**
   * Replace name and/or config on a template.
   * @param id - template id.
   * @param patch - fields to replace.
   */
  updateTemplate(
    id: string,
    patch: { name?: string; config?: EnvironmentTemplateConfig },
  ): EnvironmentTemplate | undefined {
    const existing = this.templates.get(id)
    if (!existing) return undefined
    const updated: EnvironmentTemplate = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
      updated_at: Math.floor(Date.now() / 1000),
    }
    this.templates.set(id, updated)
    this.#enqueue(() => this.#disk?.putTemplate(updated))
    return updated
  }

  /**
   * Delete a template file and memory row.
   * @param id - template id.
   */
  deleteTemplate(id: string): boolean {
    const removed = this.templates.delete(id)
    if (removed) this.#enqueue(() => this.#disk?.deleteTemplate(id))
    return removed
  }

  /**
   * Create a live env row. Without a Codebox client, the row is a local directory.
   * @param input - template, session owner, and whether to provision.
   */
  async createEnvironment(input: CreateEnvironmentInput): Promise<EnvironmentRecord> {
    const template = input.template_id !== undefined ? this.templates.get(input.template_id) : undefined
    if (input.template_id !== undefined && template === undefined) {
      throw new Error(`template not found: ${input.template_id}`)
    }
    const now = Math.floor(Date.now() / 1000)
    let env: EnvironmentRecord = {
      id: `env_${randomUUID().replaceAll('-', '')}`,
      object: 'environment',
      status: 'pending',
      provider: 'codebox',
      provider_metadata: {},
      created_at: now,
      ...(input.template_id !== undefined ? { template_id: input.template_id } : {}),
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
    }
    this.environments.set(env.id, env)
    this.#enqueue(() => this.#disk?.putEnvironment(env))
    if (this.#codebox === undefined) return this.#asLocal(env.id)
    if (input.provision === false) return env
    env = await this.provisionEnvironment(env.id, {
      ...(input.image !== undefined ? { image: input.image } : template?.config.image !== undefined ? { image: template.config.image } : {}),
      ...(template?.config.starter_files !== undefined ? { starter_files: template.config.starter_files } : {}),
      ...(template?.config.setup !== undefined ? { setup: template.config.setup } : {}),
      ...(template?.config.packages !== undefined ? { packages: template.config.packages } : {}),
      ...(template?.config.default_env !== undefined ? { default_env: template.config.default_env } : {}),
    })
    return env
  }

  /**
   * Create a codebox, wait until running, then apply template material.
   * @param environmentId - env id.
   * @param options - image and post-connect files.
   */
  async provisionEnvironment(
    environmentId: string,
    options: {
      image?: string
      starter_files?: Array<{ path: string; content: string }>
      setup?: string
      packages?: string[]
      default_env?: Record<string, string>
    } = {},
  ): Promise<EnvironmentRecord> {
    const codebox = this.#codebox
    if (codebox === undefined) {
      throw new Error('CODEBOX_BASE_URL and CODEBOX_API_KEY are required to provision environments')
    }
    const existing = this.environments.get(environmentId)
    if (existing === undefined) throw new Error(`environment not found: ${environmentId}`)
    try {
      const created = await codebox.create({
        label: environmentId,
        image: options.image?.trim() || this.#image,
        workdirRoot: '/workspace',
        ...(this.#budgetInstanceId === '' ? {} : { budgetInstanceId: this.#budgetInstanceId }),
      })
      this.#update(environmentId, { status: 'pending', provider_metadata: { codebox_id: created.id } })
      await codebox.waitUntilRunning(created.id, this.#readyTimeoutSeconds)
      if (options.packages !== undefined && options.packages.length > 0) {
        const pkgs = options.packages.map(pkg => pkg.replaceAll("'", `'\\''`)).join(' ')
        await codebox.exec(
          created.id,
          `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs}`,
          { workdir: '/workspace', waitSeconds: 60 },
        )
      }
      if (options.setup !== undefined && options.setup.trim() !== '') {
        await codebox.exec(created.id, options.setup, {
          workdir: '/workspace',
          ...(options.default_env !== undefined ? { env: options.default_env } : {}),
          waitSeconds: 60,
        })
      }
      if (options.starter_files !== undefined) {
        for (const file of options.starter_files) {
          await codebox.writeFile(created.id, toWorkspacePath(file.path), file.content)
        }
      }
      return this.#update(environmentId, {
        status: 'connected',
        provider_metadata: { codebox_id: created.id },
      }) ?? existing
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return this.#update(environmentId, { status: 'failed', error: message })
        ?? { ...existing, status: 'failed', error: message }
    }
  }

  /**
   * Refresh a non-terminal environment from Codebox.
   * @param environmentId - env id.
   */
  async refreshEnvironment(environmentId: string): Promise<EnvironmentRecord | undefined> {
    const env = this.environments.get(environmentId)
    if (env === undefined) return undefined
    if (env.provider === 'local') return env
    if (env.status === 'deleted' || env.status === 'failed' || env.status === 'cleanup') return env
    const codeboxId = env.provider_metadata.codebox_id
    if (this.#codebox === undefined || codeboxId === undefined || codeboxId === '') return env
    try {
      const remote = await this.#codebox.get(codeboxId)
      if (remote.status === 'running') return this.#update(environmentId, { status: 'connected' }) ?? env
      if (remote.status === 'spawning') return this.#update(environmentId, { status: 'pending' }) ?? env
      if (remote.status === 'failed' || remote.status === 'terminated') {
        return this.#update(environmentId, {
          status: 'failed',
          error: remote.terminatedReason ?? `codebox ${remote.status}`,
        }) ?? env
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return this.#update(environmentId, { status: 'failed', error: message }) ?? env
    }
    return env
  }

  /**
   * Destroy the codebox, when one exists, and drop the row.
   * @param environmentId - env id.
   */
  async deleteEnvironment(environmentId: string): Promise<boolean> {
    const env = this.environments.get(environmentId)
    if (env === undefined) return false
    this.#update(environmentId, { status: 'cleanup' })
    const codeboxId = env.provider_metadata.codebox_id
    if (this.#codebox !== undefined && codeboxId !== undefined && codeboxId !== '') {
      try {
        await this.#codebox.destroy(codeboxId)
      } catch {
        // Already gone is success for teardown.
      }
    }
    this.environments.delete(environmentId)
    this.#enqueue(() => this.#disk?.deleteEnvironment(environmentId))
    return true
  }

  /**
   * Tear down every environment owned by a session.
   * @param sessionId - session id.
   */
  async deleteEnvironmentsForSession(sessionId: string): Promise<void> {
    const owned = [...this.environments.values()].filter(env => env.session_id === sessionId)
    for (const env of owned) await this.deleteEnvironment(env.id)
  }

  /**
   * Turn a sandbox session body into a stored environment id and optional codebox id.
   * @param body - sandbox environment from session create.
   * @param sessionId - new session id, stored as the owner.
   */
  async resolveSandbox(
    body: { environment_id?: string; template_id?: string },
    sessionId: string,
  ): Promise<ResolvedSessionEnvironment> {
    const environmentId = body.environment_id ?? ''
    const templateId = body.template_id ?? ''
    if (environmentId === '' && templateId === '') {
      throw new Error('environment.type sandbox requires environment_id or template_id')
    }
    let env: EnvironmentRecord
    if (environmentId !== '') {
      const existing = this.environments.get(environmentId)
      if (existing === undefined) throw new Error(`environment not found: ${environmentId}`)
      env = this.#update(environmentId, { session_id: sessionId }) ?? existing
      if (env.status === 'pending' && this.#codebox !== undefined && env.provider_metadata.codebox_id === undefined) {
        const template = env.template_id !== undefined ? this.templates.get(env.template_id) : undefined
        env = await this.provisionEnvironment(env.id, {
          ...(template?.config.image !== undefined ? { image: template.config.image } : {}),
          ...(template?.config.starter_files !== undefined ? { starter_files: template.config.starter_files } : {}),
          ...(template?.config.setup !== undefined ? { setup: template.config.setup } : {}),
          ...(template?.config.packages !== undefined ? { packages: template.config.packages } : {}),
          ...(template?.config.default_env !== undefined ? { default_env: template.config.default_env } : {}),
        })
      } else if (env.status === 'pending' || env.status === 'connected') {
        env = await this.refreshEnvironment(env.id) ?? env
      }
    } else {
      env = await this.createEnvironment({ template_id: templateId, session_id: sessionId, provision: true })
    }
    return {
      environment: { type: 'sandbox', environment_id: env.id },
      ...(env.provider_metadata.codebox_id !== undefined && env.status === 'connected'
        ? { codeboxId: env.provider_metadata.codebox_id }
        : {}),
    }
  }

  /**
   * Write one file into a connected codebox.
   * @param environmentId - env id.
   * @param path - workspace-relative or `/workspace` path.
   * @param content - file body.
   */
  async writeFile(environmentId: string, path: string, content: string | Uint8Array): Promise<void> {
    const local = this.#localDirectory(environmentId)
    if (local !== undefined) {
      const absolute = this.#localFile(local, path)
      await mkdir(join(absolute, '..'), { recursive: true })
      await writeFile(absolute, content)
      return
    }
    const codebox = this.#requireCodebox()
    const env = this.#requireConnected(environmentId)
    await codebox.writeFile(env, toWorkspacePath(path), content)
  }

  /**
   * Read one file from a connected codebox.
   * @param environmentId - env id.
   * @param path - workspace-relative or `/workspace` path.
   */
  async readFile(environmentId: string, path: string): Promise<Uint8Array> {
    const local = this.#localDirectory(environmentId)
    if (local !== undefined) return readFile(this.#localFile(local, path))
    const codebox = this.#requireCodebox()
    const env = this.#requireConnected(environmentId)
    return codebox.readFile(env, toWorkspacePath(path))
  }

  /**
   * List files under `/workspace` in a connected codebox.
   * @param environmentId - env id.
   */
  async listFiles(environmentId: string): Promise<string[]> {
    const local = this.#localDirectory(environmentId)
    if (local !== undefined) return listLocalFiles(local)
    const codebox = this.#requireCodebox()
    const env = this.#requireConnected(environmentId)
    const result = await codebox.exec(
      env,
      'find /workspace -mindepth 1 -printf "%P\\n" 2>/dev/null | sort',
      { workdir: '/workspace', waitSeconds: 30 },
    )
    return result.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  }

  async #asLocal(id: string): Promise<EnvironmentRecord> {
    const existing = this.environments.get(id)
    if (existing === undefined) throw new Error(`environment not found: ${id}`)
    const dir = join(this.#localRoot, id)
    await mkdir(dir, { recursive: true })
    return this.#update(id, {
      status: 'connected',
      provider: 'local',
      provider_metadata: { workspace_directory: dir },
    }) ?? { ...existing, status: 'connected', provider: 'local', provider_metadata: { workspace_directory: dir } }
  }

  #localDirectory(environmentId: string): string | undefined {
    const env = this.environments.get(environmentId)
    if (env === undefined) throw new Error(`environment not found: ${environmentId}`)
    if (env.provider !== 'local') return undefined
    const dir = env.provider_metadata.workspace_directory
    if (dir === undefined || !isAbsolute(dir)) throw new Error(`environment ${env.id} has no local workspace`)
    return dir
  }

  #localFile(root: string, path: string): string {
    const relative = path.trim().startsWith('/workspace')
      ? path.trim().slice('/workspace'.length)
      : path
    const safe = sanitizeRelativePath(relative)
    if (safe === undefined) throw new Error('path escapes the environment workspace')
    const absolute = resolve(root, ...safe.split('/'))
    const base = resolve(root)
    if (absolute !== base && !absolute.startsWith(base + sep)) {
      throw new Error('path escapes the environment workspace')
    }
    return absolute
  }

  #requireCodebox(): CodeboxClient {
    if (this.#codebox === undefined) throw new Error('Codebox is not configured')
    return this.#codebox
  }

  #requireConnected(environmentId: string): string {
    const env = this.environments.get(environmentId)
    if (env === undefined) throw new Error(`environment not found: ${environmentId}`)
    const id = env.provider_metadata.codebox_id
    if (id === undefined || id === '') throw new Error(`environment ${env.id} has no codebox_id`)
    if (env.status !== 'connected') throw new Error(`environment ${env.id} is not connected (status=${env.status})`)
    return id
  }

  #update(
    id: string,
    patch: {
      status?: EnvironmentStatus
      provider?: EnvironmentRecord['provider']
      provider_metadata?: EnvironmentRecord['provider_metadata']
      error?: string
      session_id?: string
    },
  ): EnvironmentRecord | undefined {
    const existing = this.environments.get(id)
    if (!existing) return undefined
    const updated: EnvironmentRecord = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.provider_metadata !== undefined ? { provider_metadata: patch.provider_metadata } : {}),
      ...(patch.session_id !== undefined ? { session_id: patch.session_id } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updated_at: Math.floor(Date.now() / 1000),
    }
    if (patch.error === undefined && patch.status === 'connected') {
      const { error: _error, ...rest } = updated
      this.environments.set(id, rest)
      this.#enqueue(() => this.#disk?.putEnvironment(rest))
      return rest
    }
    this.environments.set(id, updated)
    this.#enqueue(() => this.#disk?.putEnvironment(updated))
    return updated
  }

  #enqueue(work: () => Promise<unknown> | undefined): void {
    this.#pending = this.#pending.then(async () => {
      await work()
    }, async () => {
      await work()
    })
  }
}

/**
 * List regular files under a local environment directory.
 * @param root - absolute workspace.
 */
async function listLocalFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue
      const absolute = join(dir, name)
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!info.isFile()) continue
      out.push(absolute.slice(resolve(root).length + 1).split(sep).join('/'))
    }
  }
  await walk(root)
  out.sort()
  return out
}

/**
 * Normalize a workspace-relative path to an absolute Codebox `/workspace/...` path.
 * @param path - client path.
 */
export function toWorkspacePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.startsWith('/workspace')) return trimmed
  if (trimmed.startsWith('/')) return `/workspace${trimmed}`
  return `/workspace/${trimmed}`
}
