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

export { EnvdSshConnection, type EnvdSshConfig } from './envd-ssh.ts'

export const name = 'agentry-sandbox-runtime'
export const inject = ['sandboxPolicy']
export type Config = EnvdSshConfig

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(EnvdSshConnection, config)
  ctx.plugin(SshSandboxProvider)
  ctx.plugin(SshSubprocessRuntime)
  ctx.plugin(SshFileSystem)
  ctx.inject(['ssh', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy'], (inner) => {
    inner.plugin(NodePtcRuntime, { launch: inner.ssh.ptcLaunch })
  })
}

export default { name, inject, apply }
