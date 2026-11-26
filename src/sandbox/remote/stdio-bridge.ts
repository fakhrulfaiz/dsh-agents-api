/**
 * A stdio bridge into an Agentry Sandbox: a host process whose own stdin and
 * stdout are piped to one program running inside the sandbox (an envd process,
 * see `EnvdProcessStream`). The MCP client spawns the bridge like any stdio
 * MCP server, so the server itself (Playwright MCP for the browser) runs in
 * the sandbox, under its limits and network rules, never on the API host.
 *
 * Configuration comes from the bridge's environment (never its arguments, so
 * the service key does not show in `ps`): see `BRIDGE_ENV`.
 */
import type { Readable, Writable } from 'node:stream'

/** Environment names the bridge reads. */
export const BRIDGE_ENV = {
  url: 'AGENTRY_SANDBOX_URL',
  key: 'AGENTRY_SANDBOX_KEY',
  owner: 'AGENTRY_BRIDGE_OWNER',
  sandboxId: 'AGENTRY_BRIDGE_SANDBOX_ID',
  cwd: 'AGENTRY_BRIDGE_CWD',
  user: 'AGENTRY_BRIDGE_USER',
  /** JSON array: the program and its arguments. */
  command: 'AGENTRY_BRIDGE_COMMAND',
  /** Optional JSON object: environment variables for the program. */
  programEnv: 'AGENTRY_BRIDGE_ENV',
} as const

export interface BridgeConfig {
  url: string
  key: string
  owner: string
  sandboxId: string
  cwd?: string
  user: string
  cmd: string
  args: string[]
  env?: Record<string, string>
}

/** Reads the bridge's configuration; throws naming the missing or invalid variable. */
export function bridgeConfigFromEnv(env: Record<string, string | undefined>): BridgeConfig {
  const need = (name: string): string => {
    const value = env[name]
    if (value === undefined || value === '') throw new Error(`${name} is required`)
    return value
  }
  let command: unknown
  try {
    command = JSON.parse(need(BRIDGE_ENV.command))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${BRIDGE_ENV.command} must be a JSON array of strings`)
    throw error
  }
  if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string' || part === '')) {
    throw new Error(`${BRIDGE_ENV.command} must be a JSON array of strings`)
  }
  const [cmd, ...args] = command as string[]
  const cwd = env[BRIDGE_ENV.cwd]
  let programEnv: unknown
  const rawEnv = env[BRIDGE_ENV.programEnv]
  if (rawEnv) {
    try {
      programEnv = JSON.parse(rawEnv)
    } catch {
      programEnv = undefined
    }
    if (programEnv === null || typeof programEnv !== 'object' || Array.isArray(programEnv) || Object.values(programEnv).some(v => typeof v !== 'string')) {
      throw new Error(`${BRIDGE_ENV.programEnv} must be a JSON object of strings`)
    }
  }
  return {
    url: need(BRIDGE_ENV.url),
    key: need(BRIDGE_ENV.key),
    owner: need(BRIDGE_ENV.owner),
    sandboxId: need(BRIDGE_ENV.sandboxId),
    ...(cwd ? { cwd } : {}),
    user: env[BRIDGE_ENV.user] || 'agent',
    cmd: cmd as string,
    args,
    ...(programEnv ? { env: programEnv as Record<string, string> } : {}),
  }
}

/** The part of `EnvdProcessStream` the bridge uses. */
export interface RemoteProcess extends NodeJS.ReadWriteStream {
  readonly exited: Promise<number | null>
  readonly stderrText: string
  ready(): Promise<number>
  kill(force?: boolean): Promise<void>
  destroy(error?: Error): unknown
}

/** How long a program may run on after its stdin closed before it is killed. */
export const STDIN_GRACE_MS = 2_000

/**
 * Pipe `io.stdin` into the remote program and its stdout to `io.stdout` until
 * the program ends or the bridge's stdin closes.
 * @returns the exit code to leave with: the program's, or 1 when the stream broke or it never started.
 */
export async function runStdioBridge(remote: RemoteProcess, io: { stdin: Readable; stdout: Writable; stderr: Writable }, label: string): Promise<number> {
  const report = (message: string): void => { io.stderr.write(`[agentry-sandbox-bridge] ${label}: ${message}\n`) }
  let broken: Error | undefined
  remote.on('error', (error: Error) => { broken ??= error })
  remote.pipe(io.stdout, { end: false })
  io.stdin.pipe(remote as unknown as Writable)
  let graceTimer: NodeJS.Timeout | undefined
  io.stdin.once('end', () => {
    // The client is done: give the program a moment to exit on its own, then stop it.
    graceTimer = setTimeout(() => { void remote.kill() }, STDIN_GRACE_MS)
    graceTimer.unref?.()
  })
  try {
    await remote.ready()
  } catch (error) {
    report(`could not start: ${(error as Error).message}`)
    return 1
  }
  const code = await remote.exited
  if (graceTimer) clearTimeout(graceTimer)
  io.stdin.unpipe(remote as unknown as Writable)
  if (code === null) {
    // The stream's error event comes a tick after `exited` settles.
    await new Promise<void>((r) => { setImmediate(r) })
    report(`the sandbox stream broke${broken ? `: ${broken.message}` : ''}`)
    return 1
  }
  if (code !== 0 && remote.stderrText.trim()) report(`exited with ${String(code)}: ${remote.stderrText.trim().slice(-500)}`)
  return code
}
