/**
 * Environments on the wire: the OpenAI Agents API's `agent.environment` (as the OpenAI Python
 * SDK defines it) plus our optional extension fields (`provider`, `provider_metadata`,
 * `template_id`, `session_id`, `error`, `created_at`, `updated_at`). Stored records keep our own
 * status values; `toSdkEnvironment` maps them.
 */

import type { EnvironmentRecord, EnvironmentStatus, EnvironmentTemplate } from '../environment-types.ts'
import { normalizeTemplateConfig } from './template-compat.ts'

export type SdkEnvironmentStatus = 'pending' | 'connected' | 'disconnected' | 'expired' | 'failed'

/** Our stored status to the SDK's: a backend being cleaned up is `disconnected`, a deleted one `expired`. */
const STATUS: Record<EnvironmentStatus, SdkEnvironmentStatus> = {
  pending: 'pending',
  connected: 'connected',
  failed: 'failed',
  cleanup: 'disconnected',
  deleted: 'expired',
}

export const sdkStatus = (status: EnvironmentStatus): SdkEnvironmentStatus => STATUS[status]

/** `agent.environment`, as returned to clients. */
export interface SdkEnvironment {
  id: string
  object: 'agent.environment'
  /** `self_hosted` for directories this application hosts (the local provider), `openai_hosted` for a provider-provisioned sandbox. */
  type: 'openai_hosted' | 'self_hosted'
  status: SdkEnvironmentStatus
  files: Array<
    | { type: 'inline'; id: string; path: string; size_bytes: number }
    | { type: 'file_id'; id: string; file_id: string; path: string; size_bytes: number }
  >
  plugins: Array<{ type: 'inline'; name: string; description: string }>
  skills: Array<
    | { type: 'skill_reference'; skill_id: string; name: string; description: string; version: string }
    | { type: 'inline'; name: string; description: string }
  >
  /** Extension: the provider that backs the environment. */
  provider: string
  /** Extension: provider-owned handle (`workspace_directory` for `local`). */
  provider_metadata: Record<string, string>
  template_id?: string
  session_id?: string
  error?: string
  created_at: number
  updated_at?: number
  /** Extension: display name given at create. */
  name?: string
  /** Extension (Agentry Sandbox environments): the sandbox's live state; `state: 'unknown'` when the service did not answer. */
  sandbox?: SandboxSummary
}

/** Where a sandbox's setup is, while it is `provisioning` (the sandbox service's `progress`). */
export interface SandboxProgress {
  stage: 'pulling_image' | 'starting' | 'preparing' | 'installing_packages' | 'copying_runtime' | 'writing_files' | 'running_setup' | 'finishing'
  /** `running_setup` only: which command, of how many. */
  step?: number
  steps?: number
  /** `running_setup` only: the command, cut to 120 characters. */
  detail?: string
  updated_at: number
}

export interface SandboxSummary {
  state: 'provisioning' | 'running' | 'stopped' | 'failed' | 'deleting' | 'gone' | 'unknown'
  image?: string
  place?: string
  gpus?: number | 'all'
  started_at?: number | null
  last_used_at?: number | null
  /** Only while `state` is `provisioning`. */
  progress?: SandboxProgress
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * @param record - stored environment.
 * @param template - the template it was provisioned from, when it has one and it still exists.
 * @returns the SDK `agent.environment` with our extension fields.
 */
export function toSdkEnvironment(record: EnvironmentRecord, template?: EnvironmentTemplate): SdkEnvironment {
  const config = template === undefined ? {} : normalizeTemplateConfig(template.config)
  return {
    id: record.id,
    object: 'agent.environment',
    type: record.provider === 'local' ? 'self_hosted' : 'openai_hosted',
    status: sdkStatus(record.status),
    files: (config.files ?? []).map((file, index) => file.type === 'file_id'
      ? { type: 'file_id' as const, id: `file_${String(index + 1)}`, file_id: file.file_id, path: file.path, size_bytes: 0 }
      : { type: 'inline' as const, id: `file_${String(index + 1)}`, path: file.path, size_bytes: Buffer.from(file.data, 'base64').length }),
    plugins: (config.plugins ?? []).map(plugin => ({ type: 'inline' as const, name: text(plugin['name']), description: text(plugin['description']) })),
    skills: (config.skills ?? []).map(skill => typeof skill['skill_id'] === 'string'
      ? {
          type: 'skill_reference' as const,
          skill_id: skill['skill_id'],
          name: text(skill['name']),
          description: text(skill['description']),
          version: typeof skill['version'] === 'string' ? skill['version'] : 'latest',
        }
      : { type: 'inline' as const, name: text(skill['name']), description: text(skill['description']) }),
    provider: record.provider,
    provider_metadata: record.provider_metadata,
    ...(record.template_id !== undefined ? { template_id: record.template_id } : {}),
    ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    created_at: record.created_at,
    ...(record.updated_at !== undefined ? { updated_at: record.updated_at } : {}),
  }
}
