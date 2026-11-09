/**
 * Client or request errors that map to a non-500 Agents API HTTP response.
 */
export class AgentsApiRequestError extends Error {
  /**
   * @param message - human-readable error.
   * @param status - HTTP status (default 400).
   * @param code - wire error code.
   */
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly code = 'invalid_request',
  ) {
    super(message)
    this.name = 'AgentsApiRequestError'
  }
}

/**
 * The Host could not create a session's agent or record its index row. Every
 * partial registration is undone before it is thrown; the Agents API answers
 * 500 `agent_create_failed`.
 */
export class SessionCreateError extends Error {
  /** Wire error code. */
  readonly code = 'agent_create_failed'

  /**
   * @param cause - failure from `agents.create` or the index insert.
   */
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'SessionCreateError'
  }
}
