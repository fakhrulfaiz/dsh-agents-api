import { describe, expect, it } from 'vitest'
import { forgetWorkspaceAlias, workspaceOf } from '../src/sandbox/workspace-alias.ts'

const envdExiting = (code: number, scripts: string[] = []) => ({
  userHeaders: () => ({}),
  process: {
    start: (req: { process: { args: string[] } }) => {
      scripts.push(req.process.args[1] ?? '')
      return (async function* () { yield { event: { event: { case: 'end', value: { exitCode: code } } } } })()
    },
  },
}) as never

describe('workspaceOf', () => {
  it('uses /workspace once the symlink exists, asks root once, and asks again after a reset', async () => {
    const scripts: string[] = []
    const envd = envdExiting(0, scripts)
    expect(await workspaceOf('sbx_1', envd, '/home/u/ws/sandbox-env_1')).toBe('/workspace')
    expect(await workspaceOf('sbx_1', envd, '/home/u/ws/sandbox-env_1')).toBe('/workspace')
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain("ln -s '/home/u/ws/sandbox-env_1' /workspace")
    forgetWorkspaceAlias('sbx_1')
    await workspaceOf('sbx_1', envd, '/home/u/ws/sandbox-env_1')
    expect(scripts).toHaveLength(2)
    forgetWorkspaceAlias('sbx_1')
  })

  it('keeps the long path when /workspace is something else or the sandbox cannot be reached', async () => {
    expect(await workspaceOf('sbx_2', envdExiting(1), '/d')).toBe('/d')
    const broken = { userHeaders: () => ({}), process: { start: () => { throw new Error('down') } } } as never
    expect(await workspaceOf('sbx_3', broken, '/d')).toBe('/d')
  })
})
