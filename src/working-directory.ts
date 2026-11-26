/**
 * `@agentry/api/working-directory`: DeepSeek Harness's host-level working-directory service
 * (`@deepseek-ai/dsh-working-directory`), which this bundle mounts in place of the base row.
 *
 * DSH's service registers an unscoped `system-prompt/assemble` hook that calls `ensure()` for every
 * Agent, so it stats a sandbox session's directory (`/workspace`) through the host filesystem and fails
 * the turn when the API host has no such folder. A sandbox session's preset (`agentry-sbx-*`) mounts its
 * own `dsh-working-directory` inside its isolated group, on the sandbox's filesystem. This service hands
 * `ensure()` for such an Agent to that service, so the folder is checked (and recovered) where the
 * session's tools run. Every other Agent is handled exactly as DSH does. Both services fold the same
 * `working-directory/change` events, so the prompt's directory line is the same whichever writes it last.
 */
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The part of DSH's `agentPresets` registry used here (read structurally, as the gateway does). */
interface PresetServices {
  serviceFor(agent: { ctx: unknown }, name: 'workingDirectory'): WorkingDirectoryService | undefined
}

export class AgentryWorkingDirectory extends WorkingDirectoryService {
  override ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    const own = this.presetService(agent)
    if (own !== undefined) return own.ensure(agent, signal)
    return super.ensure(agent, signal)
  }

  /** The working-directory service the Agent's preset supplies inside its isolated group, if any but this one. */
  private presetService(agent: Agent): WorkingDirectoryService | undefined {
    const presets = (this.ctx as { get?: (name: string) => unknown }).get?.call(this.ctx, 'agentPresets') as PresetServices | undefined
    const own = presets?.serviceFor?.(agent, 'workingDirectory')
    return own !== undefined && own !== this && !(own instanceof AgentryWorkingDirectory) ? own : undefined
  }
}

export default AgentryWorkingDirectory
