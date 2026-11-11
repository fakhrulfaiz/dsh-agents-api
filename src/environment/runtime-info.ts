/**
 * The script runtimes the host ships to agents: the bundled Node, Python and pnpm
 * (and the Python packages) that `@deepseek-ai/dsh-tool-workspace-dependencies` points
 * agents at. Read from the payload's `runtime.json`; shared by every session.
 */
import { readFile } from 'node:fs/promises'

export interface RuntimeInfo {
  object: 'sandbox.runtimes'
  /** False when the host has no bundled runtime payload. */
  available: boolean
  node?: string
  python?: string
  pnpm?: string
  platform?: string
  /** Python package name to version. */
  python_packages?: Record<string, string>
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/**
 * @param runtimeJsonPath - absolute path of the payload's `runtime.json`; undefined means none configured.
 * @returns the bundled runtime versions, or `{ available: false }` when the file is missing or unreadable.
 */
export async function readRuntimeInfo(runtimeJsonPath: string | undefined): Promise<RuntimeInfo> {
  if (runtimeJsonPath === undefined) return { object: 'sandbox.runtimes', available: false }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(runtimeJsonPath, 'utf8')) as Record<string, unknown>
  } catch {
    return { object: 'sandbox.runtimes', available: false }
  }
  const packages = parsed['pythonPackages']
  const python_packages = typeof packages === 'object' && packages !== null && !Array.isArray(packages)
    ? Object.fromEntries(Object.entries(packages).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined
  const node = text(parsed['node'])
  const python = text(parsed['python'])
  const pnpm = text(parsed['pnpm'])
  const platform = text(parsed['platform'])
  return {
    object: 'sandbox.runtimes',
    available: true,
    ...(node === undefined ? {} : { node }),
    ...(python === undefined ? {} : { python }),
    ...(pnpm === undefined ? {} : { pnpm }),
    ...(platform === undefined ? {} : { platform }),
    ...(python_packages === undefined ? {} : { python_packages }),
  }
}
