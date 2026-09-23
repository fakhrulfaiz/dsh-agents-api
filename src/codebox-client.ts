/**
 * Small Codebox HTTP client for environment provision.
 *
 * Command execution inside a box still belongs to the Codebox profile plugin.
 * This client only creates, waits, writes starter files, and tears boxes down.
 */

/** Settings required before any Codebox call is made. */
export interface CodeboxSettings {
  baseUrl: string
  apiKey: string
  image?: string
  readyTimeoutSeconds?: number
  budgetInstanceId?: string
}

/** One finished command inside a codebox. */
export interface CodeboxExecResult {
  execId: string
  status: 'exited'
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
}

interface CodeboxResponse {
  status: number
  json: unknown
  text: string
  bytes?: Uint8Array
}

/**
 * HTTP client for the Codebox control plane.
 */
export class CodeboxClient {
  readonly baseUrl: string
  readonly #authHeader: string
  readonly #fetchImpl: typeof fetch

  /**
   * @param settings - base URL and API key.
   * @param fetchImpl - fetch implementation, injectable in tests.
   */
  constructor(settings: CodeboxSettings, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/u, '')
    this.#authHeader = `Basic ${Buffer.from(`codebox:${settings.apiKey}`).toString('base64')}`
    this.#fetchImpl = fetchImpl
  }

  /**
   * Create a codebox. Status may still be `spawning`.
   * @param body - label, image, and workspace root.
   */
  async create(body: {
    label: string
    image?: string
    workdirRoot?: string
    budgetInstanceId?: string
  }): Promise<{ id: string; status: string; image: string }> {
    const result = await this.#request('POST', '/codebox/api/codeboxes', body)
    return result.json as { id: string; status: string; image: string }
  }

  /**
   * Fetch one codebox record.
   * @param id - codebox id.
   */
  async get(id: string): Promise<{
    id: string
    status: string
    connected?: boolean
    image?: string
    terminatedReason?: string | null
  }> {
    const result = await this.#request('GET', `/codebox/api/codeboxes/${encodeURIComponent(id)}`)
    return result.json as {
      id: string
      status: string
      connected?: boolean
      image?: string
      terminatedReason?: string | null
    }
  }

  /**
   * Delete a codebox.
   * @param id - codebox id.
   */
  async destroy(id: string): Promise<void> {
    await this.#request('DELETE', `/codebox/api/codeboxes/${encodeURIComponent(id)}`)
  }

  /**
   * Poll until the codebox is `running` or fails.
   * @param id - codebox id.
   * @param timeoutSeconds - overall wait budget.
   */
  async waitUntilRunning(id: string, timeoutSeconds: number): Promise<{ id: string; status: string }> {
    const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000
    let lastStatus = 'unknown'
    while (Date.now() < deadline) {
      const last = await this.get(id)
      lastStatus = last.status
      if (last.status === 'running') return last
      if (last.status === 'failed' || last.status === 'terminated') {
        throw new Error(
          `codebox ${id} entered ${last.status}`
          + (last.terminatedReason ? `: ${last.terminatedReason}` : ''),
        )
      }
      await sleep(500)
    }
    throw new Error(`codebox ${id} did not become running within ${timeoutSeconds}s (last=${lastStatus})`)
  }

  /**
   * Start a command and wait until it exits.
   * @param id - codebox id.
   * @param command - shell source.
   * @param options - workdir and wait ceiling.
   */
  async exec(
    id: string,
    command: string,
    options: { workdir?: string; env?: Record<string, string>; waitSeconds?: number } = {},
  ): Promise<CodeboxExecResult> {
    const waitSeconds = Math.min(120, Math.max(1, options.waitSeconds ?? 10))
    const started = await this.#request('POST', `/codebox/api/codeboxes/${encodeURIComponent(id)}/exec`, {
      command,
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      ...(options.env === undefined ? {} : { env: options.env }),
      waitSeconds,
    })
    const body = started.json as {
      execId: string
      status: string
      exitCode?: number | null
      signal?: string | null
      stdout?: string
      stderr?: string
      truncated?: boolean
    }
    if (body.status === 'exited') return exited(body.execId, body)
    return this.#pollExec(id, body.execId, waitSeconds, body.stdout ?? '', body.stderr ?? '')
  }

  /**
   * Read a file from the codebox as bytes.
   * @param id - codebox id.
   * @param path - absolute path inside the box.
   */
  async readFile(id: string, path: string): Promise<Uint8Array> {
    const result = await this.#request(
      'GET',
      `/codebox/api/codeboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`,
      undefined,
      true,
    )
    return result.bytes ?? new TextEncoder().encode(result.text)
  }

  /**
   * Write a file into the codebox.
   * @param id - codebox id.
   * @param path - absolute path inside the box.
   * @param body - file bytes or text.
   */
  async writeFile(id: string, path: string, body: Uint8Array | string): Promise<void> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    const response = await this.#fetchImpl(
      `${this.baseUrl}/codebox/api/codeboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: this.#authHeader,
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from(bytes),
      },
    )
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`codebox PUT file → ${response.status}: ${text || response.statusText}`)
    }
  }

  async #pollExec(
    id: string,
    execId: string,
    waitSeconds: number,
    stdout: string,
    stderr: string,
  ): Promise<CodeboxExecResult> {
    let stdoutFrom = stdout.length
    let stderrFrom = stderr.length
    for (;;) {
      const polled = await this.#request(
        'GET',
        `/codebox/api/codeboxes/${encodeURIComponent(id)}/execs/${encodeURIComponent(execId)}`
        + `?waitSeconds=${String(waitSeconds)}`
        + `&stdoutFrom=${String(stdoutFrom)}`
        + `&stderrFrom=${String(stderrFrom)}`,
      )
      const body = polled.json as {
        status: string
        exitCode?: number | null
        signal?: string | null
        stdout?: string
        stderr?: string
        truncated?: boolean
      }
      const stdoutChunk = body.stdout ?? ''
      const stderrChunk = body.stderr ?? ''
      stdout += stdoutChunk
      stderr += stderrChunk
      stdoutFrom += stdoutChunk.length
      stderrFrom += stderrChunk.length
      if (body.status === 'exited') {
        return exited(execId, { ...body, stdout, stderr })
      }
    }
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
    binary = false,
  ): Promise<CodeboxResponse> {
    const response = await this.#fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.#authHeader,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (binary) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!response.ok) {
        throw new Error(`codebox ${method} ${path} → ${response.status}: ${new TextDecoder().decode(bytes) || response.statusText}`)
      }
      return { status: response.status, json: null, text: '', bytes }
    }
    const text = await response.text()
    const json = text === '' ? null : JSON.parse(text) as unknown
    if (!response.ok) {
      const message = (json as { message?: string } | null)?.message ?? text ?? response.statusText
      throw new Error(`codebox ${method} ${path} → ${response.status}: ${message}`)
    }
    return { status: response.status, json, text }
  }
}

/**
 * @param execId - exec id.
 * @param body - exited payload.
 */
function exited(
  execId: string,
  body: {
    exitCode?: number | null
    signal?: string | null
    stdout?: string
    stderr?: string
    truncated?: boolean
  },
): CodeboxExecResult {
  return {
    execId,
    status: 'exited',
    exitCode: body.exitCode ?? null,
    signal: body.signal ?? null,
    stdout: body.stdout ?? '',
    stderr: body.stderr ?? '',
    truncated: body.truncated === true,
  }
}

/**
 * @param ms - delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
