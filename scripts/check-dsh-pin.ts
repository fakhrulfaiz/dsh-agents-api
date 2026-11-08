/**
 * Verifies that the DSH checkout at `DSH_ROOT` is at the commit of the tag
 * named in `dsh.pin` and has no changes to tracked files. Run as
 * `pnpm check:dsh-pin`; exits 1 on mismatch.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Result of {@link checkDshPin}. */
export type DshPinResult = { ok: true } | { ok: false; reason: string }

async function revParse(cwd: string, rev: string): Promise<string> {
  return (await exec('git', ['rev-parse', '--verify', '--quiet', rev], { cwd })).stdout.trim()
}

/**
 * Compares `HEAD` of the DSH checkout with the commit that `pin` names and rejects tracked-file changes.
 *
 * @param opts.dshRoot - Directory of the DSH git checkout.
 * @param opts.pin - Tag (or other revision) the checkout must be at.
 * @returns `{ ok: true }` when `HEAD` is the pinned commit and tracked files are clean, otherwise `{ ok: false, reason }` naming the pin.
 */
export async function checkDshPin(opts: { dshRoot: string; pin: string }): Promise<DshPinResult> {
  const { dshRoot, pin } = opts
  let pinned: string
  try {
    pinned = await revParse(dshRoot, `${pin}^{commit}`)
  } catch (error) {
    return { ok: false, reason: `Cannot resolve pin ${pin} in ${dshRoot}: ${(error as Error).message.split('\n')[0]}` }
  }
  let head: string
  try {
    head = await revParse(dshRoot, 'HEAD')
  } catch (error) {
    return { ok: false, reason: `Cannot resolve HEAD in ${dshRoot} (pin ${pin}): ${(error as Error).message.split('\n')[0]}` }
  }
  if (head !== pinned) {
    return { ok: false, reason: `DSH_ROOT ${dshRoot} is at ${head}, but pin ${pin} is ${pinned}. Check out ${pin}.` }
  }
  let dirty: string
  try {
    dirty = (await exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dshRoot })).stdout.trim()
  } catch (error) {
    return { ok: false, reason: `Cannot read git status in ${dshRoot} (pin ${pin}): ${(error as Error).message.split('\n')[0]}` }
  }
  if (dirty) {
    return { ok: false, reason: `DSH_ROOT ${dshRoot} has changes to tracked files (pin ${pin}); restore them:\n${dirty}` }
  }
  return { ok: true }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dshRoot = process.env['DSH_ROOT']
  if (!dshRoot) {
    console.error('DSH_ROOT is not set. Run `export DSH_ROOT=/path/to/dsh-pinned` (a checkout of the tag in dsh.pin).')
    process.exit(1)
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const pin = (await readFile(join(repoRoot, 'dsh.pin'), 'utf8')).trim()
  const result = await checkDshPin({ dshRoot: resolve(dshRoot), pin })
  if (!result.ok) {
    console.error(result.reason)
    process.exit(1)
  }
  console.log(`DSH pin OK: ${pin}`)
}
