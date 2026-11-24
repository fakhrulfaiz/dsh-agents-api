/**
 * Environment templates on the wire and in storage.
 *
 * The wire shape is the OpenAI Agents API's `agent.environment.template` (as the
 * OpenAI Python SDK defines it); our additions (`provider`, `image`,
 * `unsupported_fields`) are optional extension fields. Stored templates keep the
 * create-params shape, including confidential parts (inline file data, `env`,
 * setup commands, archives) that responses never return. Templates stored in the
 * Codebox-era layout are mapped on read by `normalizeTemplateConfig`.
 */

import type { EnvironmentTemplate, EnvironmentTemplateConfig, TemplateFileInput } from '../environment-types.ts'
import type { SandboxProvider, TemplateField } from '../sandbox/contract.ts'

/** `agent.environment.template`, as returned to clients. */
export interface SdkTemplate {
  id: string
  object: 'agent.environment.template'
  name: string | null
  created_at: number
  updated_at: number
  capability_directories: string[]
  files: Array<{ type: 'file_id'; path: string; file_id: string } | { type: 'inline'; path: string; size_bytes: number }>
  network: { access: 'enabled' | 'disabled' | 'restricted'; allowed_domains: string[] }
  packages: { npm: string[]; python: string[]; system: string[] }
  plugins: Array<{ type: 'inline'; name: string; description: string }>
  skills: Array<
    | { type: 'skill_reference'; skill_id: string; version?: string }
    | { type: 'inline'; name: string; description: string }
  >
  /** Extension: the sandbox provider that provisions environments from this template. */
  provider: string
  /** Extension: container image for container providers. */
  image?: string
  /** Extension: CPU and memory limits for container providers. */
  resources?: { cpus?: number; memory_mb?: number }
  /** Extension: template fields set to something the provider cannot apply; provisioning fails while any remain. */
  unsupported_fields: TemplateField[]
}

const NETWORK_ACCESS = ['enabled', 'disabled', 'restricted'] as const

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** Absolute destination path inside the environment, as the SDK uses (`/workspace/...`). */
const workspacePath = (path: string): string => (path.startsWith('/') ? path : `/workspace/${path}`)

/**
 * Map the Codebox-era layout onto the SDK fields and return a config holding only SDK fields and `image`.
 * Idempotent. Legacy keys: `starter_files` to inline `files`, `default_env` to `env`, `setup` to
 * `setup_commands`, a `packages` array to `packages.system`. SDK fields already present win.
 */
export function normalizeTemplateConfig(config: EnvironmentTemplateConfig): EnvironmentTemplateConfig {
  const { setup, starter_files: starter, default_env: defaultEnv, packages, ...rest } = config
  const out: EnvironmentTemplateConfig = { ...rest }
  if (Array.isArray(packages)) {
    if (packages.length > 0) out.packages = { system: packages }
  } else if (packages !== undefined) out.packages = packages
  if (out.files === undefined && starter !== undefined && starter.length > 0) {
    out.files = starter.map((file): TemplateFileInput => ({
      type: 'inline',
      path: workspacePath(file.path),
      data: Buffer.from(file.content, 'utf8').toString('base64'),
    }))
  }
  if (out.env === undefined && defaultEnv !== undefined && Object.keys(defaultEnv).length > 0) out.env = defaultEnv
  if (out.setup_commands === undefined && typeof setup === 'string' && setup.trim() !== '') out.setup_commands = [{ command: setup }]
  return out
}

/** Template fields the config sets to something that needs a provider capability. */
export function requestedFields(config: EnvironmentTemplateConfig): TemplateField[] {
  const c = normalizeTemplateConfig(config)
  const fields: TemplateField[] = []
  if ((c.files?.length ?? 0) > 0) fields.push('files')
  if (c.env !== undefined && Object.keys(c.env).length > 0) fields.push('env')
  if (c.network !== undefined && c.network.access !== 'enabled') fields.push('network')
  const packages = Array.isArray(c.packages) ? undefined : c.packages
  if (packages !== undefined && (strings(packages.npm).length + strings(packages.python).length + strings(packages.system).length) > 0) fields.push('packages')
  if ((c.plugins?.length ?? 0) > 0) fields.push('plugins')
  if ((c.skills?.length ?? 0) > 0) fields.push('skills')
  if ((c.capability_directories?.length ?? 0) > 0) fields.push('capability_directories')
  if ((c.setup_commands?.length ?? 0) > 0) fields.push('setup_commands')
  if (c.image !== undefined && c.image !== '') fields.push('image')
  if (c.resources !== undefined && (c.resources.cpus !== undefined || c.resources.memory_mb !== undefined)) fields.push('resources')
  return fields
}

/**
 * @param config - stored template config.
 * @param provider - the template's provider, or `undefined` when it is not registered (then every requested field is unsupported).
 * @returns requested fields the provider does not list in its capabilities.
 */
export function unsupportedFields(config: EnvironmentTemplateConfig, provider: SandboxProvider | undefined): TemplateField[] {
  const supported: readonly TemplateField[] = provider?.capabilities.templateFields ?? []
  return requestedFields(config).filter(field => !supported.includes(field))
}

/**
 * @param stored - stored template, possibly in the Codebox-era layout.
 * @param provider - the template's provider when registered.
 * @returns the SDK `agent.environment.template` plus the extension fields.
 */
export function toSdkTemplate(stored: EnvironmentTemplate, provider: SandboxProvider | undefined): SdkTemplate {
  const config = normalizeTemplateConfig(stored.config)
  const packages = Array.isArray(config.packages) ? {} : (config.packages ?? {})
  return {
    id: stored.id,
    object: 'agent.environment.template',
    name: stored.name === '' ? null : stored.name,
    created_at: stored.created_at,
    updated_at: stored.updated_at ?? stored.created_at,
    capability_directories: strings(config.capability_directories),
    files: (config.files ?? []).map(file => file.type === 'file_id'
      ? { type: 'file_id' as const, path: file.path, file_id: file.file_id }
      : { type: 'inline' as const, path: file.path, size_bytes: Buffer.from(file.data, 'base64').length }),
    network: {
      access: config.network?.access ?? 'enabled',
      allowed_domains: strings(config.network?.allowed_domains),
    },
    packages: { npm: strings(packages.npm), python: strings(packages.python), system: strings(packages.system) },
    // Archives are not unpacked here, so inline plugin and skill names come from what the client supplied.
    plugins: (config.plugins ?? []).map(plugin => ({
      type: 'inline' as const,
      name: typeof plugin['name'] === 'string' ? plugin['name'] : '',
      description: typeof plugin['description'] === 'string' ? plugin['description'] : '',
    })),
    skills: (config.skills ?? []).map(skill => typeof skill['skill_id'] === 'string'
      ? {
          type: 'skill_reference' as const,
          skill_id: skill['skill_id'],
          ...(typeof skill['version'] === 'string' ? { version: skill['version'] } : {}),
        }
      : {
          type: 'inline' as const,
          name: typeof skill['name'] === 'string' ? skill['name'] : '',
          description: typeof skill['description'] === 'string' ? skill['description'] : '',
        }),
    provider: stored.provider,
    ...(config.image !== undefined && config.image !== '' ? { image: config.image } : {}),
    ...(config.resources !== undefined ? { resources: config.resources } : {}),
    unsupported_fields: unsupportedFields(config, provider),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Parse a template create or update body (the SDK's create or update params plus our `provider` and
 * `image`). Unknown keys are ignored; known keys with the wrong shape are an error. Fields are never
 * rejected for being unsupported by a provider.
 * @param body - parsed JSON body.
 * @returns the fields that were present, or an error message.
 */
export function parseTemplateInput(raw: unknown): { name?: string | null; provider?: string; config: EnvironmentTemplateConfig } | { error: string } {
  if (!isRecord(raw)) return { error: 'request body must be a JSON object' }
  // The earlier nested form `{ name, config: { ... } }` is still accepted; top-level fields win.
  const body: Record<string, unknown> = isRecord(raw['config']) ? { ...raw['config'], ...raw } : raw
  const config: EnvironmentTemplateConfig = {}
  const out: { name?: string | null; provider?: string; config: EnvironmentTemplateConfig } = { config }
  if (body['name'] !== undefined) {
    if (body['name'] !== null && typeof body['name'] !== 'string') return { error: 'Field "name" must be a string' }
    out.name = body['name']
  }
  if (body['provider'] !== undefined) {
    if (typeof body['provider'] !== 'string' || body['provider'] === '') return { error: 'Field "provider" must be a non-empty string' }
    out.provider = body['provider']
  }
  const list = (key: string): unknown[] | undefined | 'bad' => {
    const value = body[key]
    if (value === undefined || value === null) return undefined
    return Array.isArray(value) ? value : 'bad'
  }
  const capability = list('capability_directories')
  if (capability === 'bad' || (capability !== undefined && !capability.every(item => typeof item === 'string'))) return { error: 'Field "capability_directories" must be an array of strings' }
  if (capability !== undefined) config.capability_directories = capability as string[]
  if (body['env'] !== undefined && body['env'] !== null) {
    if (!isRecord(body['env']) || !Object.values(body['env']).every(value => typeof value === 'string')) return { error: 'Field "env" must be an object of strings' }
    config.env = body['env'] as Record<string, string>
  }
  const files = list('files')
  if (files === 'bad') return { error: 'Field "files" must be an array' }
  if (files !== undefined) {
    const parsed: TemplateFileInput[] = []
    for (const file of files) {
      if (!isRecord(file) || typeof file['path'] !== 'string' || file['path'] === '') return { error: 'Each file needs a string "path"' }
      if (file['type'] === 'file_id' && typeof file['file_id'] === 'string') parsed.push({ type: 'file_id', path: file['path'], file_id: file['file_id'] })
      else if (file['type'] === 'inline' && typeof file['data'] === 'string') parsed.push({ type: 'inline', path: file['path'], data: file['data'] })
      else return { error: `File "${file['path']}" must be {type:"inline", data} or {type:"file_id", file_id}` }
    }
    config.files = parsed
  }
  if (body['network'] !== undefined && body['network'] !== null) {
    const network = body['network']
    if (!isRecord(network) || !NETWORK_ACCESS.includes(network['access'] as (typeof NETWORK_ACCESS)[number])) return { error: 'Field "network.access" must be "enabled", "disabled" or "restricted"' }
    config.network = { access: network['access'] as (typeof NETWORK_ACCESS)[number], allowed_domains: strings(network['allowed_domains']) }
  }
  if (body['packages'] !== undefined && body['packages'] !== null) {
    const packages = body['packages']
    // A flat list is the earlier layout (system packages).
    if (Array.isArray(packages)) config.packages = strings(packages)
    else if (isRecord(packages)) config.packages = { npm: strings(packages['npm']), python: strings(packages['python']), system: strings(packages['system']) }
    else return { error: 'Field "packages" must be an object with npm, python and system lists' }
  }
  // The earlier layout: kept as sent and mapped by `normalizeTemplateConfig`.
  if (typeof body['setup'] === 'string') config.setup = body['setup']
  if (Array.isArray(body['starter_files'])) config.starter_files = body['starter_files'].filter((f): f is { path: string; content: string } => isRecord(f) && typeof f['path'] === 'string' && typeof f['content'] === 'string')
  if (isRecord(body['default_env'])) config.default_env = body['default_env'] as Record<string, string>
  for (const key of ['plugins', 'skills'] as const) {
    const value = list(key)
    if (value === 'bad' || (value !== undefined && !value.every(isRecord))) return { error: `Field "${key}" must be an array of objects` }
    if (value !== undefined) config[key] = value as Array<Record<string, unknown>>
  }
  const commands = list('setup_commands')
  if (commands === 'bad' || (commands !== undefined && !commands.every(item => isRecord(item) && typeof item['command'] === 'string'))) return { error: 'Field "setup_commands" must be an array of {command, cwd?}' }
  if (commands !== undefined) {
    config.setup_commands = (commands as Array<Record<string, unknown>>).map(item => ({
      command: item['command'] as string,
      ...(typeof item['cwd'] === 'string' ? { cwd: item['cwd'] } : {}),
    }))
  }
  if (body['image'] !== undefined && body['image'] !== null) {
    if (typeof body['image'] !== 'string') return { error: 'Field "image" must be a string' }
    config.image = body['image']
  }
  if (body['resources'] !== undefined && body['resources'] !== null) {
    const r = body['resources']
    if (!isRecord(r)) return { error: 'Field "resources" must be an object with cpus and memory_mb' }
    const resources: { cpus?: number; memory_mb?: number } = {}
    if (r['cpus'] !== undefined && r['cpus'] !== null) {
      if (typeof r['cpus'] !== 'number' || !(r['cpus'] >= 0.1 && r['cpus'] <= 64)) return { error: 'Field "resources.cpus" must be a number from 0.1 to 64' }
      resources.cpus = r['cpus']
    }
    if (r['memory_mb'] !== undefined && r['memory_mb'] !== null) {
      if (typeof r['memory_mb'] !== 'number' || !Number.isInteger(r['memory_mb']) || r['memory_mb'] < 128 || r['memory_mb'] > 262_144) return { error: 'Field "resources.memory_mb" must be a whole number from 128 to 262144' }
      resources.memory_mb = r['memory_mb']
    }
    if (Object.keys(resources).length > 0) config.resources = resources
  }
  return out
}
