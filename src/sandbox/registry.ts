/** Providers by name, with one default. */

import type { SandboxCapabilities, SandboxProvider } from './contract.ts'

/** A provider name that is not registered; the message lists the registered names. */
export class UnknownSandboxProviderError extends Error {
  constructor(name: string, available: readonly string[]) {
    super(`unknown sandbox provider "${name}"; available: ${available.length > 0 ? available.join(', ') : 'none'}`)
    this.name = 'UnknownSandboxProviderError'
  }
}

export class SandboxRegistry {
  readonly #providers = new Map<string, SandboxProvider>()
  readonly #defaultKind: string

  /** @param defaultKind - name of the provider used when a request names none. */
  constructor(defaultKind: string) {
    this.#defaultKind = defaultKind
  }

  /**
   * @param provider - provider to add.
   * @returns a function that removes it again.
   * @throws when the name is already registered.
   */
  register(provider: SandboxProvider): () => void {
    if (this.#providers.has(provider.kind)) throw new Error(`sandbox provider "${provider.kind}" is already registered`)
    this.#providers.set(provider.kind, provider)
    return () => {
      if (this.#providers.get(provider.kind) === provider) this.#providers.delete(provider.kind)
    }
  }

  get(kind: string): SandboxProvider | undefined {
    return this.#providers.get(kind)
  }

  /** @throws UnknownSandboxProviderError when `kind` is not registered. */
  require(kind: string): SandboxProvider {
    const provider = this.#providers.get(kind)
    if (provider === undefined) throw new UnknownSandboxProviderError(kind, [...this.#providers.keys()])
    return provider
  }

  /** @throws UnknownSandboxProviderError when the default is not registered. */
  default(): SandboxProvider {
    return this.require(this.#defaultKind)
  }

  list(): { name: string; capabilities: SandboxCapabilities; default: boolean }[] {
    return [...this.#providers.values()].map((provider) => ({
      name: provider.kind,
      capabilities: provider.capabilities,
      default: provider.kind === this.#defaultKind,
    }))
  }
}
