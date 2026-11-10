/**
 * Local environment provider: each environment is the host directory
 * `<workspacesRoot>/<owner>/<environmentId>/`.
 */

import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OwnerId } from '../auth/authenticator.ts'
import { sanitizeRelativePath } from '../artifacts.ts'
import type { EnvironmentRecord } from '../environment-types.ts'
import type { SandboxProvider } from '../sandbox/contract.ts'

/** One path segment: no separators, not `.` or `..`. */
const SEGMENT = /^[A-Za-z0-9_@.-]+$/u

/**
 * Check that an id can be used as one directory name.
 * @param value - candidate directory name.
 * @param what - field name for the error.
 * @returns `value` when it is a single safe segment.
 * @throws when `value` could address another directory.
 */
export function directorySegment(value: string, what: string): string {
  if (!SEGMENT.test(value) || value === '.' || value === '..') throw new Error(`${what} "${value}" is not a valid directory name`)
  return value
}

/**
 * @param base - absolute directory.
 * @param target - absolute path.
 * @returns whether `target` is `base` or below it.
 */
function within(base: string, target: string): boolean {
  return target === base || target.startsWith(base + sep)
}

/**
 * @param path - absolute path.
 * @returns whether `path` exists and is a symbolic link; a write would follow it.
 */
async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error: unknown) {
    // A missing file is the normal case for a new write.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * List regular files below `root`, skipping `.git`, `node_modules`, and symbolic links.
 * @param root - absolute workspace.
 * @returns sorted workspace-relative paths.
 */
async function listRegularFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      if (name === '.git' || name === 'node_modules') continue
      const absolute = join(dir, name)
      const info = await lstat(absolute)
      if (info.isDirectory()) await walk(absolute)
      else if (info.isFile()) out.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  await walk(root)
  return out.sort()
}

/**
 * Create the local provider.
 * @param workspacesRoot - absolute directory holding `<owner>/<environmentId>/` workspaces.
 * @returns a provider that never touches paths outside `workspacesRoot`.
 */
export function createLocalProvider(workspacesRoot: string): SandboxProvider {
  const root = resolve(workspacesRoot)

  /** Workspace directory of `record`, checked to lie below the root. */
  const workspaceOf = (record: EnvironmentRecord): string => {
    const dir = record.provider_metadata.workspace_directory
    if (dir === undefined || !isAbsolute(dir)) throw new Error(`environment ${record.id} has no local workspace`)
    const absolute = resolve(dir)
    if (!within(root, absolute) || absolute === root) throw new Error(`environment ${record.id} workspace lies outside ${root}`)
    return absolute
  }

  /** Absolute path of a client file path inside `workspace`, before symbolic links are resolved. */
  const fileIn = (workspace: string, path: string): string => {
    const trimmed = path.trim()
    const relativePath = trimmed.startsWith('/workspace') ? trimmed.slice('/workspace'.length) : trimmed
    const safe = sanitizeRelativePath(relativePath)
    if (safe === undefined) throw new Error('path escapes the environment workspace')
    return resolve(workspace, ...safe.split('/'))
  }

  /** Reject a resolved path that a symbolic link carried out of the workspace. */
  const assertResolvedWithin = async (workspace: string, target: string): Promise<void> => {
    if (!within(await realpath(workspace), await realpath(target))) throw new Error('path escapes the environment workspace')
  }

  return {
    kind: 'local',
    // The agent's own tools run in the Host against this directory; of the template fields only starter files apply.
    capabilities: { templateFields: ['starter_files'], files: true, exec: true },
    async create(owner: OwnerId, environmentId: string, input) {
      const workspacePath = join(root, directorySegment(owner, 'owner'), directorySegment(environmentId, 'environment id'))
      await mkdir(workspacePath, { recursive: true })
      for (const file of input.template?.starter_files ?? []) {
        const safe = sanitizeRelativePath(file.path)
        if (safe === undefined) throw new Error(`starter file path "${file.path}" escapes the environment workspace`)
        const target = resolve(workspacePath, ...safe.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content)
      }
      return { status: 'connected', workspacePath }
    },
    async status(record) {
      const workspace = workspaceOf(record)
      try {
        return (await stat(workspace)).isDirectory() ? 'connected' : 'failed'
      } catch (error: unknown) {
        // A missing workspace directory means the environment is gone; other errors propagate.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'failed'
        throw error
      }
    },
    async destroy(record) {
      await rm(workspaceOf(record), { recursive: true, force: true })
    },
    async listFiles(record) {
      return listRegularFiles(workspaceOf(record))
    },
    async readFile(record, path) {
      const workspace = workspaceOf(record)
      const target = fileIn(workspace, path)
      await assertResolvedWithin(workspace, target)
      return readFile(target)
    },
    async writeFile(record, path, content) {
      const workspace = workspaceOf(record)
      const target = fileIn(workspace, path)
      await mkdir(dirname(target), { recursive: true })
      await assertResolvedWithin(workspace, dirname(target))
      if (await isSymbolicLink(target)) throw new Error('path escapes the environment workspace')
      await writeFile(target, content)
    },
  }
}
