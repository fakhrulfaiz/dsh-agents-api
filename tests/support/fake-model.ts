/** Fakes for the live model selection a settings update drives. */

import { vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Subset of `agent.model` the gateway uses. */
export type FakeModel = {
  current: ReturnType<typeof vi.fn<() => ReturnType<Agent['model']['current']>>>
  select: ReturnType<typeof vi.fn<Agent['model']['select']>>
}

/**
 * Build a fake `agent.model` that reports the profile default route.
 * @returns the fake with `current` and `select` spies.
 */
export function fakeModel(): FakeModel {
  return {
    current: vi.fn(() => ({ provider: 'deepseek-official', model: 'deepseek-flash' })),
    select: vi.fn(),
  }
}

/**
 * Build a fake `ctx.llm` whose `resolveCallConfig` accepts every route.
 * @returns the fake with a `resolveCallConfig` spy.
 */
export function fakeLlm(): { resolveCallConfig: ReturnType<typeof vi.fn<(config: LlmCallConfig) => Promise<LlmCallConfig>>> } {
  return { resolveCallConfig: vi.fn((config: LlmCallConfig) => Promise.resolve(config)) }
}
