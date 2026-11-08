/**
 * Saved-agent record construction. Storage lives in `store/`.
 */

import { randomUUID } from 'node:crypto'
import type { CreateAgentParams, OAIAgent, UpdateAgentParams } from './types.ts'

/**
 * Copy optional agent fields that `exactOptionalPropertyTypes` forbids as
 * explicit `undefined` assignments.
 * @param params - create or update fields.
 * @returns spreadable optional properties.
 */
function optionalAgentFields(params: CreateAgentParams | UpdateAgentParams): Pick<OAIAgent, 'multi_agent' | 'reasoning' | 'service_tier' | 'text' | 'host_tools'> {
  return {
    ...(params.multi_agent !== undefined ? { multi_agent: params.multi_agent } : {}),
    ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
    ...(params.service_tier !== undefined ? { service_tier: params.service_tier } : {}),
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.host_tools !== undefined ? { host_tools: params.host_tools } : {}),
  }
}

/**
 * Build an agent resource without inserting it into the saved-agent list.
 * Session-local inline configurations use this so `GET /v1/agents` stays
 * reserved for `POST /v1/agents`.
 * @param params - create fields; callers must supply `model`.
 * @returns a new agent resource.
 */
export function materializeAgent(params: CreateAgentParams): OAIAgent {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: `agent_${randomUUID().replaceAll('-', '')}`,
    object: 'agent',
    created_at: now,
    updated_at: now,
    name: params.name ?? null,
    instructions: params.instructions ?? null,
    model: params.model,
    metadata: params.metadata ?? {},
    tools: params.tools ?? [],
    ...optionalAgentFields(params),
  }
}

/**
 * Merge an update into a saved agent. Omitted fields keep their values;
 * supplied objects replace the field; `null` metadata or tools clear it.
 * @param existing - stored agent.
 * @param params - update fields.
 * @returns the replacement record with a new `updated_at`.
 */
export function updatedAgent(existing: OAIAgent, params: UpdateAgentParams): OAIAgent {
  return {
    ...existing,
    updated_at: Math.floor(Date.now() / 1000),
    name: params.name !== undefined ? params.name : existing.name,
    instructions: params.instructions !== undefined ? params.instructions : existing.instructions,
    model: params.model !== undefined ? params.model : existing.model,
    metadata: params.metadata === undefined ? existing.metadata : (params.metadata ?? {}),
    tools: params.tools === undefined ? existing.tools : (params.tools ?? []),
    ...optionalAgentFields(params),
  }
}
