/**
 * Session resources derived from the Postgres index row and its stored setup.
 */

import type { ProjectionBase } from './history/projector.ts'
import { redactAgentSecrets } from './redact.ts'
import type { SessionIndexRow } from './store/store.ts'
import type { OAIAgentSession, ReasoningEffort, SessionConfig, UpdateSessionParams } from './types.ts'

/**
 * Setup of a session. Rows written before migration 0002 have none; they get
 * a stand-in built from the index columns so they can still be listed and read.
 * @param row - session index row.
 * @returns the stored setup, or the stand-in for a row without one.
 */
export function configOf(row: SessionIndexRow): SessionConfig {
  if (row.body !== null) return row.body
  const created = Math.floor(row.createdAt.getTime() / 1000)
  return {
    agent: {
      id: row.agentId === null ? row.id : row.agentId,
      object: 'agent',
      created_at: created,
      updated_at: created,
      name: null,
      instructions: null,
      model: row.model,
      metadata: {},
      tools: [],
      ...(row.reasoningEffort === null ? {} : { reasoning: { effort: row.reasoningEffort as ReasoningEffort } }),
    },
    environment: { type: 'none' },
    metadata: {},
    vault_ids: [],
  }
}

/**
 * @param row - session index row.
 * @returns the configuration the wire projection needs.
 */
export function baseOf(row: SessionIndexRow): ProjectionBase {
  const config = configOf(row)
  return {
    sessionId: row.id,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    agent: config.agent,
    environment: config.environment,
    metadata: config.metadata,
    vaultIds: config.vault_ids,
  }
}

/**
 * Session resource for a session that is not live in this process.
 * `interrupted` shows as `failed`; `required_actions` is empty and `usage` null
 * because both come from live state.
 * @param row - session index row.
 * @returns the wire session.
 */
export function sessionFromRow(row: SessionIndexRow): OAIAgentSession {
  const config = configOf(row)
  return {
    id: row.id,
    object: 'agent.session',
    created_at: Math.floor(row.createdAt.getTime() / 1000),
    last_active_at: Math.floor(row.updatedAt.getTime() / 1000),
    status: row.status === 'interrupted' ? 'failed' : row.status,
    error: row.lastError,
    metadata: config.metadata,
    vault_ids: config.vault_ids,
    agent: redactAgentSecrets(config.agent),
    environment: config.environment,
    required_actions: [],
    usage: null,
  }
}

/**
 * Apply a session-settings update. Only `model`, `reasoning.effort`,
 * `service_tier`, and `metadata` change; `metadata: null` clears the map.
 * @param config - current setup.
 * @param params - update body.
 * @returns the new setup, or `undefined` when `agent.model` is null or empty.
 */
export function applySessionUpdate(config: SessionConfig, params: UpdateSessionParams): SessionConfig | undefined {
  const patch = params.agent
  if (patch?.model === '' || patch?.model === null) return undefined
  const now = Math.floor(Date.now() / 1000)
  let agent = config.agent
  if (patch?.model !== undefined) agent = { ...agent, model: patch.model, updated_at: now }
  if (patch?.service_tier !== undefined) agent = { ...agent, updated_at: now, service_tier: patch.service_tier }
  if (patch?.reasoning !== undefined) {
    const effort = patch.reasoning.effort
    agent = { ...agent, updated_at: now, reasoning: { ...agent.reasoning, ...(effort === undefined ? {} : { effort }) } }
  }
  return {
    ...config,
    agent,
    metadata: params.metadata === undefined ? config.metadata : (params.metadata ?? {}),
  }
}
