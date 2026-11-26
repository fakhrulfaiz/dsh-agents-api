/**
 * `/workspace` inside a sandbox. New sandboxes mount their workspace disk at `/workspace` directly and need
 * no alias. Older sandboxes (made while DSH checked the working directory on the host) and sandboxes on a
 * shared machine mount it at a long path that mirrors a host placeholder folder; for those, everything the
 * user and the sandbox tools see goes through `/workspace`, a symlink to that path made by root on first use.
 * Sessions that DSH runs inside such a sandbox still use the long path.
 */
import { runInEnvd, sq, type EnvdClient } from '@agentry/sandbox/client'

export const WORKSPACE_ALIAS = '/workspace'
const known = new Map<string, string>()

/**
 * The folder to use as the sandbox's workspace: `/workspace` once it points at `directory`, else `directory`
 * (a failure here must never block the terminal or a command, so it falls back quietly).
 */
export async function workspaceOf(sandboxId: string, envd: EnvdClient, directory: string): Promise<string> {
  // A sandbox whose disk is mounted at /workspace needs no alias.
  if (directory === WORKSPACE_ALIAS) return directory
  const cached = known.get(sandboxId)
  if (cached !== undefined) return cached
  let chosen = directory
  try {
    const w = WORKSPACE_ALIAS
    const d = sq(directory)
    // A link already there is repointed if needed; an empty real folder (the image ships one) is replaced; anything else is left alone.
    const script = `if [ -L ${w} ]; then [ "$(readlink ${w})" = ${d} ] || ln -sfn ${d} ${w}; elif [ -d ${w} ] && [ -z "$(ls -A ${w})" ]; then rmdir ${w} && ln -s ${d} ${w}; elif [ ! -e ${w} ]; then ln -s ${d} ${w}; fi; [ "$(readlink -f ${w})" = "$(readlink -f ${d})" ] || { echo "/workspace exists and is not empty or not this sandbox's workspace" >&2; exit 1; }`
    const res = await runInEnvd(envd, 'root', script, { timeoutMs: 15_000 })
    if (res.code === 0) chosen = WORKSPACE_ALIAS
    else console.warn(`agents-api: /workspace alias for ${sandboxId} not made (exit ${String(res.code)}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`)
  } catch (error) {
    // Not reachable or no root: keep the long path.
    console.warn(`agents-api: /workspace alias for ${sandboxId} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (chosen === WORKSPACE_ALIAS) known.set(sandboxId, chosen)
  return chosen
}

/** Forget a sandbox's alias (it was reset or deleted, so a new container has none). */
export function forgetWorkspaceAlias(sandboxId: string): void {
  known.delete(sandboxId)
}
