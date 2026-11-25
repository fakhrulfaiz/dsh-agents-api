/**
 * Copies skill folders into an Agentry Sandbox at their identical host paths
 * (written as root, so `agent` can read but not change them), so SKILL.md and
 * the scripts it names resolve inside the sandbox exactly as on the host.
 */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SandboxApi } from '@agentry/sandbox/client'

const MAX_FILE = 5 * 1024 * 1024
const SKIP = new Set(['node_modules', '.git'])

async function* walk(dir: string): AsyncGenerator<string> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    const info = await lstat(path)
    if (info.isDirectory()) yield* walk(path)
    else if (info.isFile() && info.size <= MAX_FILE) yield path
  }
}

/** Copy every file under `dirs` into the sandbox at the same path; returns how many were written. */
export async function copySkillsInto(api: SandboxApi, sandboxId: string, dirs: readonly string[]): Promise<number> {
  const envd = api.envd(sandboxId)
  let count = 0
  for (const dir of dirs) {
    const pending: Promise<void>[] = []
    for await (const path of walk(dir)) {
      pending.push(readFile(path).then((bytes) => envd.writeFile(path, bytes, 'root')))
      count += 1
      if (pending.length >= 8) await Promise.all(pending.splice(0))
    }
    await Promise.all(pending)
  }
  return count
}
