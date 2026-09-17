/**
 * In-memory store for saved Agents API agent configurations.
 */

import { randomUUID } from 'node:crypto'
import { paginate, type ListQuery } from './http.ts'
import type { CreateAgentParams, OAIAgent, OAIListResponse, UpdateAgentParams } from './types.ts'

/**
 * Copy optional agent fields that `exactOptionalPropertyTypes` forbids as
 * explicit `undefined` assignments.
 * @param params - create or update fields.
 * @returns spreadable optional properties.
 */
function optionalAgentFields(params: CreateAgentParams | UpdateAgentParams): Pick<OAIAgent, 'multi_agent' | 'reasoning' | 'service_tier' | 'text'> {
  return {
    ...(params.multi_agent !== undefined ? { multi_agent: params.multi_agent } : {}),
    ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
    ...(params.service_tier !== undefined ? { service_tier: params.service_tier } : {}),
    ...(params.text !== undefined ? { text: params.text } : {}),
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

/** In-memory saved-agent directory. */
export class AgentStore {
  private readonly agents = new Map<string, OAIAgent>()

  /**
   * Save a new agent and return it.
   * @param params - create fields.
   * @returns the stored agent.
   */
  create(params: CreateAgentParams): OAIAgent {
    const agent = materializeAgent(params)
    this.agents.set(agent.id, agent)
    return agent
  }

  /**
   * Look up a saved agent.
   * @param id - agent id.
   * @returns the agent, or `undefined` when missing.
   */
  get(id: string): OAIAgent | undefined {
    return this.agents.get(id)
  }

  /**
   * Merge an update into a saved agent. Omitted fields keep their values;
   * supplied objects replace the field.
   * @param id - agent id.
   * @param params - update fields.
   * @returns the updated agent, or `undefined` when missing.
   */
  update(id: string, params: UpdateAgentParams): OAIAgent | undefined {
    const existing = this.agents.get(id)
    if (!existing) return undefined
    const updated: OAIAgent = {
      ...existing,
      updated_at: Math.floor(Date.now() / 1000),
      name: params.name !== undefined ? params.name : existing.name,
      instructions: params.instructions !== undefined ? params.instructions : existing.instructions,
      model: params.model !== undefined ? params.model : existing.model,
      metadata: params.metadata === undefined ? existing.metadata : (params.metadata ?? {}),
      tools: params.tools === undefined ? existing.tools : (params.tools ?? []),
      ...optionalAgentFields(params),
    }
    this.agents.set(id, updated)
    return updated
  }

  /**
   * Delete a saved agent.
   * @param id - agent id.
   * @returns whether the agent existed.
   */
  delete(id: string): boolean {
    return this.agents.delete(id)
  }

  /**
   * List saved agents with OpenAI cursor pagination.
   * @param opts - limit, after, order.
   * @returns one page of agents.
   */
  list(opts: ListQuery): OAIListResponse<OAIAgent> {
    return paginate([...this.agents.values()], opts, agent => agent.created_at)
  }
}
