/**
 * Copy an attached file into `<workspace>/uploads/` for the agent's file and shell tools.
 *
 * The agent can write inside its workspace, so everything under it is untrusted: `uploads/` may be replaced by a
 * symlink, and a name may collide with an existing file. The copy never follows a link, never overwrites, and
 * verifies where the bytes landed.
 */

import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { AgentsApiRequestError } from '../errors.ts'
import { numberedName } from './names.ts'

/** Directory inside the workspace that receives attached files. */
export const UPLOADS_DIRECTORY = 'uploads'

/** Most names tried (`name`, `name-1`, ...) before giving up. */
const MAX_ATTEMPTS = 1000

/** A copy made into the workspace. */
export interface WorkspaceCopy {
  /** Path relative to the workspace, `uploads/<name>`. */
  relative: string
  /** Absolute path of the new file. */
  absolute: string
  /** Removes the copy where it is not a host file (a sandbox); host copies are removed by path. */
  remove?: () => Promise<void>
}

/** The workspace cannot safely receive the file. Maps to 409 `uploads_unsafe`. */
function unsafe(message: string): AgentsApiRequestError {
  return new AgentsApiRequestError(message, 409, 'uploads_unsafe')
}

/**
 * Create `uploads/` if needed and prove it is a real directory inside the workspace.
 * @param root - real path of the workspace.
 * @returns the real path of `uploads/`.
 * @throws AgentsApiRequestError 409 `uploads_unsafe` when `uploads` is a symlink, not a directory, or resolves outside the workspace.
 */
async function ensureUploadsDirectory(root: string): Promise<string> {
  const directory = join(root, UPLOADS_DIRECTORY)
  let info: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    info = await lstat(directory)
  } catch (error: unknown) {
    // A missing `uploads/` is created below; any other failure propagates.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (info === undefined) await mkdir(directory)
  else if (info.isSymbolicLink()) throw unsafe('The workspace "uploads" entry is a symbolic link')
  else if (!info.isDirectory()) throw unsafe('The workspace "uploads" entry is not a directory')
  const real = await realpath(directory)
  if (real !== directory) throw unsafe('The workspace "uploads" directory resolves outside the workspace')
  return real
}

/**
 * Write `source` to a new file in `<workspace>/uploads/`. An existing name is never overwritten: the copy is
 * named `name-1.ext`, `name-2.ext`, and so on.
 * @param workspace - session workspace directory (must exist).
 * @param name - sanitized leaf name.
 * @param source - file bytes.
 * @returns where the copy was written.
 * @throws AgentsApiRequestError 409 `uploads_unsafe` when `uploads/` is not a plain directory inside the workspace, or the new file resolved outside it (the stray file is removed).
 */
export async function copyIntoUploads(workspace: string, name: string, source: AsyncIterable<Uint8Array>): Promise<WorkspaceCopy> {
  const root = await realpath(workspace)
  const directory = await ensureUploadsDirectory(root)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const leaf = attempt === 0 ? name : numberedName(name, attempt)
    const absolute = join(directory, leaf)
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
    } catch (error: unknown) {
      // The name is taken (a file, or a symlink the agent planted): try the next one.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      await pipeline(Readable.from(source, { objectMode: false }), handle.createWriteStream())
      const landed = await realpath(absolute)
      if (landed !== absolute && !landed.startsWith(directory + sep)) throw unsafe('The copy resolved outside the workspace')
    } catch (error: unknown) {
      await rm(absolute, { force: true })
      throw error
    }
    return { relative: `${UPLOADS_DIRECTORY}/${leaf}`, absolute }
  }
  throw unsafe(`Could not find a free name for "${name}" in uploads/`)
}
