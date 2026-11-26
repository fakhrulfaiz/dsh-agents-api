/**
 * `lib/sandbox-stdio-bridge.js`: the bridge program (see `stdio-bridge.ts`).
 * Started by the MCP client with `process.execPath`; exits with the remote
 * program's exit code, and stops the remote program when it is stopped.
 */
import { createSandboxApi } from '@agentry/sandbox/client'
import { EnvdProcessStream } from './envd-stream.ts'
import { bridgeConfigFromEnv, runStdioBridge } from './stdio-bridge.ts'

async function main(): Promise<number> {
  let config
  try {
    config = bridgeConfigFromEnv(process.env)
  } catch (error) {
    process.stderr.write(`[agentry-sandbox-bridge] ${(error as Error).message}\n`)
    return 2
  }
  const envd = createSandboxApi({ url: config.url, key: config.key, owner: config.owner }).envd(config.sandboxId)
  const remote = new EnvdProcessStream(envd, { cmd: config.cmd, args: config.args, user: config.user, ...(config.env ? { env: config.env } : {}), ...(config.cwd ? { cwd: config.cwd } : {}) })
  const stop = (): void => {
    void remote.kill().finally(() => process.exit(143))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return runStdioBridge(remote, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, `${config.sandboxId} ${config.cmd}`)
}

void main().then((code) => { process.exit(code) }, (error: unknown) => {
  process.stderr.write(`[agentry-sandbox-bridge] ${(error as Error).message}\n`)
  process.exit(1)
})
