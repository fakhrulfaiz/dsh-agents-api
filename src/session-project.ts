/**
 * Project defaults applied when a session is created.
 */

import type { CreateSessionParams, OAIProject } from './types.ts'

/**
 * Resolve the agent and environment a new session inherits from its Project.
 * Fields supplied on the request win over the Project's defaults. A session
 * without a Project stays unfiled, so callers pass `null` when no owner-scoped
 * active Project was resolved.
 *
 * @param body - session create body; never mutated.
 * @param project - owner-scoped active Project, or `null` for an unfiled session.
 * @returns a new create body with the resolved project id and defaults.
 */
export function resolveProjectDefaults(
  body: CreateSessionParams,
  project: OAIProject | null | undefined,
): CreateSessionParams {
  if (project === null || project === undefined) return { ...body, project_id: null }
  const explicitAgent = body.agent !== undefined || body.agent_id !== undefined
  return {
    ...body,
    ...(explicitAgent || project.agent_id === null ? {} : { agent_id: project.agent_id }),
    ...(body.environment !== undefined || project.environment === null ? {} : { environment: project.environment }),
    project_id: project.id,
  }
}
