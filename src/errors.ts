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
    readonly status: 400 | 404 = 400,
    readonly code = 'invalid_request',
  ) {
    super(message)
    this.name = 'AgentsApiRequestError'
  }
}
