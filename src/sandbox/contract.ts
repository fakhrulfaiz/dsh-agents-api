/**
 * The sandbox provider contract: an environment backend plus what it can do.
 * Providers register with the `SandboxRegistry`; the gateway never names a
 * concrete provider.
 */

import type { EnvironmentProvider } from '../environment/provider.ts'

/** Fields of an environment template a provider may support: the OpenAI Agents API template fields, plus our `image` extension. */
export type TemplateField =
  | 'files'
  | 'env'
  | 'network'
  | 'packages'
  | 'plugins'
  | 'skills'
  | 'capability_directories'
  | 'setup_commands'
  | 'image'
  | 'resources'

/** What a provider supports; clients read this from `GET /agents/environments/providers`. */
export interface SandboxCapabilities {
  /** Template fields the provider applies. A template asking for any other field is stored, but provisioning it fails. */
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
