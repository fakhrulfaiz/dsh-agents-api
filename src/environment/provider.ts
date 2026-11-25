/**
 * Where environment workspaces live. The gateway stores `EnvironmentRecord`
 * rows; a provider creates, inspects, and removes the workspace behind one.
 */

import type { OwnerId } from '../auth/authenticator.ts'
import type { EnvironmentRecord, EnvironmentStatus, EnvironmentTemplateConfig } from '../environment-types.ts'

/** Fields a client supplies for a new environment, plus the owner's template config when `template_id` names one. */
export interface CreateEnvironmentInput {
  template_id?: string
  session_id?: string
  image?: string
  /** Extension: a display name (at most 80 characters). */
  name?: string
  /** Config of the template named by `template_id`, resolved by the caller within the owner's templates. */
  template?: EnvironmentTemplateConfig
}

/** Outcome of `EnvironmentProvider.create`. */
export interface EnvironmentCreateResult {
  status: EnvironmentStatus
  /** Absolute workspace path inside the environment. */
  workspacePath: string
  /** Provider handle (container id, remote box id) stored in the record's `provider_metadata`. */
  handle?: Record<string, string>
  /** Failure detail when `status` is `failed`. */
  error?: string
}

/** Workspace backend for environments. Methods reject paths that escape the workspace. */
export interface EnvironmentProvider {
  readonly kind: string
  /**
   * @param owner - owning principal.
   * @param environmentId - new environment id.
   * @param input - client fields and resolved template config.
   * @returns the initial status and workspace path.
   */
  create(owner: OwnerId, environmentId: string, input: CreateEnvironmentInput): Promise<EnvironmentCreateResult>
  /**
   * @param record - stored environment.
   * @returns the backend's current status.
   */
  status(record: EnvironmentRecord): Promise<EnvironmentStatus>
  /**
   * Remove the workspace. An already missing workspace is success.
   * @param record - stored environment.
   */
  destroy(record: EnvironmentRecord): Promise<void>
  /**
   * @param record - stored environment.
   * @returns workspace-relative paths of regular files, sorted.
   */
  listFiles(record: EnvironmentRecord): Promise<string[]>
  /**
   * @param record - stored environment.
   * @param path - workspace-relative path, or one under `/workspace`.
   * @returns file bytes.
   */
  readFile(record: EnvironmentRecord, path: string): Promise<Uint8Array>
  /**
   * Create or replace a file, creating parent directories.
   * @param record - stored environment.
   * @param path - workspace-relative path, or one under `/workspace`.
   * @param content - file bytes.
   */
  writeFile(record: EnvironmentRecord, path: string, content: Uint8Array): Promise<void>
}

/**
 * Normalize a workspace-relative path to an absolute `/workspace/...` path.
 * @param path - client path.
 * @returns path under `/workspace`.
 */
export function toWorkspacePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.startsWith('/workspace')) return trimmed
  if (trimmed.startsWith('/')) return `/workspace${trimmed}`
  return `/workspace/${trimmed}`
}
