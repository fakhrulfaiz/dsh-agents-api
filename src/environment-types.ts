/**
 * Environment templates and live environment records.
 *
 * These match the CoreAgent JSON layout. Session create still accepts the
 * existing `none`, `self_hosted`, and `openai_hosted` values beside `local`
 * and `sandbox`.
 */

/** A file a template places in the environment: inline base64 data or a Files API reference (the SDK's `HostedEnvironmentFileParam`). */
export type TemplateFileInput =
  | { type: 'inline'; path: string; data: string }
  | { type: 'file_id'; path: string; file_id: string }

/**
 * Fields stored on an environment template. The first group is the OpenAI Agents API template
 * shape; `image` is our extension; the last group is the Codebox-era layout, still read from old
 * stored templates and mapped by `normalizeTemplateConfig`.
 */
export interface EnvironmentTemplateConfig {
  capability_directories?: string[]
  env?: Record<string, string>
  files?: TemplateFileInput[]
  network?: { access: 'enabled' | 'disabled' | 'restricted'; allowed_domains?: string[] }
  /** The SDK shape, or the legacy flat list of system packages. */
  packages?: { npm?: string[]; python?: string[]; system?: string[] } | string[]
  plugins?: Array<Record<string, unknown>>
  setup_commands?: Array<{ command: string; cwd?: string }>
  skills?: Array<Record<string, unknown>>
  /** Extension: a container image for container providers. */
  image?: string
  /** Extension: CPU and memory limits for container providers. */
  resources?: { cpus?: number; memory_mb?: number }
  /** Legacy. */
  setup?: string
  /** Legacy. */
  starter_files?: Array<{ path: string; content: string }>
  /** Legacy. */
  default_env?: Record<string, string>
}

/** Saved environment template (`tpl_*`). */
export interface EnvironmentTemplate {
  id: string
  object: 'environment.template'
  name: string
  /** Sandbox provider name (`local`, ...). Templates stored before providers were pluggable may say `codebox`, which no longer exists. */
  provider: string
  config: EnvironmentTemplateConfig
  created_at: number
  updated_at?: number
}

/** Live environment lifecycle status. */
export type EnvironmentStatus = 'pending' | 'connected' | 'failed' | 'cleanup' | 'deleted'

/** Live environment (`env_*`). `local` is a host directory; other providers register with the sandbox registry. */
export interface EnvironmentRecord {
  id: string
  object: 'environment'
  template_id?: string
  session_id?: string
  status: EnvironmentStatus
  /** Name of the provider that backs this environment. */
  provider: string
  /** Provider-owned handle: `workspace_directory` for `local`, an id for others. */
  provider_metadata: Record<string, string>
  error?: string
  created_at: number
  updated_at?: number
}

/** Absolute host workspace, same cwd contract as `self_hosted`. */
export interface OAILocalEnvironment {
  type: 'local'
  workspace_directory: string
}

/** Attach a live environment, or provision one from a template. */
export interface OAISandboxEnvironment {
  type: 'sandbox'
  environment_id?: string
  template_id?: string
}

/** Sandbox reference stored on a session after resolution. */
export interface OAISandboxSessionEnvironment {
  type: 'sandbox'
  environment_id: string
}
