/**
 * Environment templates and live Codebox records.
 *
 * These match the CoreAgent JSON layout. Session create still accepts the
 * existing `none`, `self_hosted`, and `openai_hosted` values beside `local`
 * and `sandbox`.
 */

/** Codebox blueprint fields stored on an environment template. */
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
  provider: 'codebox'
  config: EnvironmentTemplateConfig
  created_at: number
  updated_at?: number
}

/** Live environment lifecycle status. */
export type EnvironmentStatus = 'pending' | 'connected' | 'failed' | 'cleanup' | 'deleted'

/** Live environment (`env_*`). `local` is a host directory. `codebox` is a sandbox when one is configured. */
export interface EnvironmentRecord {
  id: string
  object: 'environment'
  template_id?: string
  session_id?: string
  status: EnvironmentStatus
  provider: 'codebox' | 'local'
  provider_metadata: { codebox_id?: string; workspace_directory?: string }
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
