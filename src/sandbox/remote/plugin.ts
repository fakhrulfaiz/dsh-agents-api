/**
 * `@agentry/api/sandbox-runtime`: one Cordis plugin that gives its (isolated)
 * context an Agentry Sandbox as the execution world — `ssh` (EnvdSshConnection),
 * then DeepSeek Harness's own remote providers on top of it: `fs`
 * (SshFileSystem), `subprocess` (SshSubprocessRuntime), `sandbox`
 * (SshSandboxProvider) and `ptcRuntime` (NodePtcRuntime with the helper's PTC
 * launch). `sandboxPolicy` comes from the surrounding composition.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import { EnvdSshConnection, type EnvdSshConfig } from './envd-ssh.ts'
import { registerSandboxDependencies } from './dependencies.ts'

export { EnvdSshConnection, type EnvdSshConfig } from './envd-ssh.ts'

export const name = 'agentry-sandbox-runtime'
export const inject = ['sandboxPolicy']
export type Config = EnvdSshConfig

/**
 * Mounts the connection and then each provider, awaiting every one, so the
 * preset's audit (which runs once this row has activated) sees fs, subprocess,
 * sandbox and ptcRuntime already provided.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(EnvdSshConnection, config)
  await ctx.plugin(SshSandboxProvider)
  await ctx.plugin(SshSubprocessRuntime)
  await ctx.plugin(SshFileSystem)
  const ssh = ctx.get('ssh') as EnvdSshConnection | undefined
  if (ssh === undefined) throw new Error('the sandbox connection did not start')
  await ctx.plugin(NodePtcRuntime, { launch: ssh.ptcLaunch })
  // Shadows the host's tool, which would report the server's bundled runtime instead of the sandbox's.
  // Optional: registered whenever the tools service is present (always, in a session), never blocking the runtime.
  ctx.inject(['tools'], (inner) => { registerSandboxDependencies(inner, config) })
}

export default { name, inject, apply }
