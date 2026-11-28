/**
 * Project create and update shared by the `/agents/projects` routes and the `project_*` tools, so both
 * accept and reject the same input.
 */
import { randomUUID } from 'node:crypto'
import type { OwnerId } from './auth/authenticator.ts'
import { normalizeWorkspaceSubdir } from './sandbox/workspace-subdir.ts'
import type { Store } from './store/store.ts'
import type { OAIEnvironmentConfig, OAIProject } from './types.ts'

/** Project fields a caller may set. Omitted fields keep their stored value. */
export type ProjectInput = Partial<Pick<OAIProject, 'name' | 'agent_id' | 'environment' | 'pinned'>>

/**
 * Validate a project create or update body.
 * @param raw - parsed JSON body.
 * @param partial - update: omitted fields are left alone; create: `name` is required.
 * @returns the accepted fields, or a client-facing error message.
 */
export function parseProjectInput(raw: Record<string, unknown>, partial: boolean): { value: ProjectInput } | { error: string } {
  const value: ProjectInput = {}
  if (!partial || raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim() === '') return { error: 'Field "name" must be a non-empty string' }
    value.name = raw.name.trim()
  }
  if (raw.agent_id !== undefined) {
    if (raw.agent_id !== null && typeof raw.agent_id !== 'string') return { error: 'Field "agent_id" must be a string or null' }
    value.agent_id = raw.agent_id
  }
  if (raw.environment !== undefined) {
    if (raw.environment !== null && (typeof raw.environment !== 'object' || Array.isArray(raw.environment))) return { error: 'Field "environment" must be an environment config or null' }
    value.environment = raw.environment as OAIEnvironmentConfig | null
    const directory = (raw.environment as { directory?: unknown } | null)?.directory
    if (directory !== undefined) {
      const folder = normalizeWorkspaceSubdir(directory)
      if (typeof folder === 'object') return { error: folder.error }
    }
  }
  if (raw.pinned !== undefined) {
    if (typeof raw.pinned !== 'boolean') return { error: 'Field "pinned" must be a boolean' }
    value.pinned = raw.pinned
  }
  return { value }
}

/**
 * Save a new active project for `owner`.
 * @param value - accepted fields with `name` set (`parseProjectInput(raw, false)`).
 */
export async function createProject(store: Store, owner: OwnerId, value: ProjectInput): Promise<OAIProject> {
  const now = Math.floor(Date.now() / 1000)
  return store.projects.create(owner, {
    id: `proj_${randomUUID().replaceAll('-', '')}`,
    object: 'project',
    name: value.name!,
    status: 'active',
    pinned: value.pinned ?? false,
    agent_id: value.agent_id ?? null,
    environment: value.environment ?? null,
    archived_at: null,
    created_at: now,
    updated_at: now,
  })
}

/**
 * Apply accepted fields to a stored project.
 * @returns the updated project, or `undefined` when it disappeared.
 */
export async function updateProject(store: Store, owner: OwnerId, project: OAIProject, value: ProjectInput): Promise<OAIProject | undefined> {
  return store.projects.update(owner, project.id, { ...project, ...value, updated_at: Math.floor(Date.now() / 1000) })
}
