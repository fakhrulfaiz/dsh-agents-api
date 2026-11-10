/**
 * Environment templates and live environment records.
 *
 * These match the CoreAgent JSON layout. Session create still accepts the
 * existing `none`, `self_hosted`, and `openai_hosted` values beside `local`
 * and `sandbox`.
 */

/** Blueprint fields stored on an environment template (to be aligned with the OpenAI Agents API template shape). */
export interface EnvironmentTemplateConfig {
  image?: string
  setup?: string
  packages?: string[]
  starter_files?: Array<{ path: string; content: string }>
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
