import { describe, expect, it } from 'vitest'
import { parseProbe, PROBE, registerSandboxDependencies } from '../src/sandbox/remote/dependencies.ts'

describe('sandbox load_workspace_dependencies', () => {
  it('reads the probe output and keeps only known fields', () => {
    const out = parseProbe('noise\n{"python":"/usr/bin/python3","pythonPackages":"/usr/lib/py","pythonDistributions":{"pandas":"3.1.1"},"node":"/usr/local/bin/node","extra":1}\n', '')
    expect(out).toEqual({ environment: 'sandbox', python: '/usr/bin/python3', pythonPackages: '/usr/lib/py', pythonDistributions: { pandas: '3.1.1' }, node: '/usr/local/bin/node' })
  })

  it('works for an image without Python and says why it failed otherwise', () => {
    expect(parseProbe('{"python":"","pythonPackages":"","pythonDistributions":{},"node":"/n"}', '')).toMatchObject({ python: '', node: '/n' })
    expect(() => parseProbe('', 'bash: boom')).toThrow(/boom/)
  })

  it('probes with plain shell and python3, never host paths', () => {
    expect(PROBE).toContain('command -v python3')
    expect(PROBE).not.toMatch(/\.dsh|office-runtime/)
  })

  it('registers under the same name as the host tool so it shadows it in the sandbox scope', () => {
    const names: string[] = []
    registerSandboxDependencies({ tools: { register: (d: { name: string }) => { names.push(d.name); return () => {} } } } as never, { owner: 'o', sandboxId: 'sbx_1', workspace: '/w' })
    expect(names).toEqual(['load_workspace_dependencies'])
  })
})
