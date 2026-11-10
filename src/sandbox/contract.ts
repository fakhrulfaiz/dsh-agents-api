/**
 * The sandbox provider contract: an environment backend plus what it can do.
 * Providers register with the `SandboxRegistry`; the gateway never names a
 * concrete provider.
 */

import type { EnvironmentProvider } from '../environment/provider.ts'

/** Fields of an environment template (`EnvironmentTemplateConfig`) a provider may support. */
export type TemplateField = 'image' | 'setup' | 'packages' | 'starter_files' | 'default_env'

/** What a provider supports; clients read this from `GET /agents/environments/providers`. */
export interface SandboxCapabilities {
  /** Template fields the provider applies. A template naming any other field is rejected for this provider. */
  readonly templateFields: readonly TemplateField[]
  /** Whether the provider can list, read and write environment files. */
  readonly files: boolean
  /** Whether an agent can run its own tools (commands, file edits) in this environment. Required to back a session. */
  readonly exec: boolean
}

/** An environment provider with a free-form name and declared capabilities. */
export interface SandboxProvider extends EnvironmentProvider {
  readonly kind: string
  readonly capabilities: SandboxCapabilities
}
