/**
 * Per-owner secrets (connector keys) sealed in the store. The plain value leaves this module only
 * through `get`, for mounting a session's tools; every other answer is a status with `last4`.
 */
import type { OwnerId } from '../auth/authenticator.ts'
import type { Store } from '../store/store.ts'
import { last4, openSecret, SecretOpenError, sealSecret } from './seal.ts'

/** Shortest accepted `secrets.key`, in bytes. */
export const MIN_SECRETS_KEY_BYTES = 32

/** `secrets.key` is not set, so secrets cannot be stored. */
export class SecretsDisabledError extends Error {
  constructor() {
    super('this server cannot store connector keys; set AGENTRY_SECRETS_KEY (secrets.key)')
    this.name = 'SecretsDisabledError'
  }
}

/** `secrets.key` is set but shorter than 32 bytes. */
export class SecretsKeyTooShortError extends Error {
  constructor() {
    super(`agents-api: "secrets.key" (AGENTRY_SECRETS_KEY) must be at least ${String(MIN_SECRETS_KEY_BYTES)} bytes`)
    this.name = 'SecretsKeyTooShortError'
  }
}

/**
 * @param key - configured `secrets.key`; empty or absent means off.
 * @throws SecretsKeyTooShortError when set but shorter than 32 bytes.
 */
export function validateSecretsKey(key: string | undefined): void {
  if (key === undefined || key === '') return
  if (Buffer.byteLength(key, 'utf8') < MIN_SECRETS_KEY_BYTES) throw new SecretsKeyTooShortError()
}

/** What may be shown about a secret. */
export interface SecretStatus {
  configured: boolean
  last4: string | null
  /** Epoch seconds of the last save; null when not configured. */
  updated_at: number | null
}

/** Options for {@link OwnerSecrets}. */
export interface OwnerSecretsOptions {
  /** `secrets.key`; absent or empty disables storing secrets. */
  key?: string | undefined
  /** The attached store, read at call time. */
  store: () => Store
  /** Receives one warning per owner and name whose row cannot be opened. Never the value. */
  warn: (message: string) => void
}

const NOT_CONFIGURED: SecretStatus = { configured: false, last4: null, updated_at: null }

/** Sealed per-owner secrets. */
export class OwnerSecrets {
  readonly #key: string | undefined
  readonly #store: () => Store
  readonly #warn: (message: string) => void
  readonly #warned = new Set<string>()

  constructor(options: OwnerSecretsOptions) {
    validateSecretsKey(options.key)
    this.#key = options.key === '' ? undefined : options.key
    this.#store = options.store
    this.#warn = options.warn
  }

  /** Whether `secrets.key` is set. */
  get enabled(): boolean {
    return this.#key !== undefined
  }

  /**
   * @returns the status; a row that cannot be opened reads as not configured.
   */
  async status(owner: OwnerId, name: string): Promise<SecretStatus> {
    if (this.#key === undefined) return NOT_CONFIGURED
    const row = await this.#store().secrets.get(owner, name)
    if (row === undefined || this.#open(owner, name, row.sealed) === undefined) return NOT_CONFIGURED
    return { configured: true, last4: row.last4, updated_at: row.updated_at }
  }

  /**
   * Seal and save, replacing an earlier value.
   * @throws SecretsDisabledError without `secrets.key`.
   */
  async set(owner: OwnerId, name: string, value: string): Promise<SecretStatus> {
    if (this.#key === undefined) throw new SecretsDisabledError()
    const row = await this.#store().secrets.put(owner, name, { sealed: sealSecret(this.#key, owner, name, value), last4: last4(value) })
    this.#warned.delete(`${owner}\0${name}`)
    return { configured: true, last4: row.last4, updated_at: row.updated_at }
  }

  /** @throws SecretsDisabledError without `secrets.key`. */
  async remove(owner: OwnerId, name: string): Promise<SecretStatus> {
    if (this.#key === undefined) throw new SecretsDisabledError()
    await this.#store().secrets.delete(owner, name)
    return NOT_CONFIGURED
  }

  /**
   * The plain value, for mounting a session's tools only. Never put it in a response, a log line or a saved config.
   * @returns `undefined` when off, missing, or not openable (logged once per owner and name).
   */
  async get(owner: OwnerId, name: string): Promise<string | undefined> {
    if (this.#key === undefined) return undefined
    const row = await this.#store().secrets.get(owner, name)
    return row === undefined ? undefined : this.#open(owner, name, row.sealed)
  }

  #open(owner: OwnerId, name: string, sealed: string): string | undefined {
    try {
      return openSecret(this.#key!, owner, name, sealed)
    } catch (error: unknown) {
      if (!(error instanceof SecretOpenError)) throw error
      const id = `${owner}\0${name}`
      if (!this.#warned.has(id)) {
        this.#warned.add(id)
        this.#warn(`agents-api: the stored "${name}" secret of owner ${owner} cannot be opened (AGENTRY_SECRETS_KEY changed?); treating it as missing`)
      }
      return undefined
    }
  }
}
