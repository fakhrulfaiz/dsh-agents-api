/**
 * `load_workspace_dependencies` for sandbox sessions. The host's
 * `@deepseek-ai/dsh-tool-workspace-dependencies` reads the server's bundled
 * Office runtime from the host disk, so inside a sandbox it reported paths that
 * do not exist there. This tool is registered in the sandbox preset's scope,
 * where it shadows the global one, and reports the sandbox's own Python,
 * Node.js and pnpm by asking the container.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createSandboxApi, runInEnvd } from '@agentry/sandbox/client'
import { sandboxCredentials } from '../presets.ts'

export interface SandboxDependenciesConfig {
  url?: string
  key?: string
  owner: string
  sandboxId: string
  workspace: string
}

export interface SandboxDependencies {
  environment: 'sandbox'
  python: string
  pythonPackages: string
  pythonDistributions: Record<string, string>
  node?: string
  nodePackages?: string
  pnpm?: string
}

/** Runs in the sandbox as `agent`; prints one JSON object. Works without Python (then only the shell part answers). */
export const PROBE = String.raw`
node=$(command -v node || true); pnpm=$(command -v pnpm || true)
npmroot=$( [ -n "$node" ] && npm root -g 2>/dev/null || true)
if command -v python3 >/dev/null 2>&1; then
  NODE="$node" PNPM="$pnpm" NPMROOT="$npmroot" python3 - <<'PY'
import json, os, sys, sysconfig, importlib.metadata as m
dists = {}
for d in m.distributions():
    name = d.metadata.get('Name')
    if name: dists[name] = d.version
out = {"python": sys.executable, "pythonPackages": sysconfig.get_paths()["purelib"], "pythonDistributions": dict(sorted(dists.items(), key=lambda kv: kv[0].lower()))}
for key, env in (("node", "NODE"), ("pnpm", "PNPM"), ("nodePackages", "NPMROOT")):
    if os.environ.get(env): out[key] = os.environ[env]
print(json.dumps(out))
PY
else
  printf '{"python":"","pythonPackages":"","pythonDistributions":{}%s%s}\n' "$( [ -n "$node" ] && printf ',"node":"%s"' "$node")" "$( [ -n "$pnpm" ] && printf ',"pnpm":"%s"' "$pnpm")"
fi`

/** Parses the probe's output; throws with the container's stderr when it did not answer JSON. */
export function parseProbe(stdout: string, stderr: string): SandboxDependencies {
  const line = stdout.trim().split('\n').pop() ?? ''
  let value: Partial<SandboxDependencies>
  try {
    value = JSON.parse(line) as Partial<SandboxDependencies>
  } catch {
    throw new Error(`could not read the sandbox's software${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}`)
  }
  return {
    environment: 'sandbox',
    python: value.python ?? '',
    pythonPackages: value.pythonPackages ?? '',
    pythonDistributions: value.pythonDistributions ?? {},
    ...(value.node ? { node: value.node } : {}),
    ...(value.nodePackages ? { nodePackages: value.nodePackages } : {}),
    ...(value.pnpm ? { pnpm: value.pnpm } : {}),
  }
}

/** Registers the sandbox's `load_workspace_dependencies` in `ctx` (the sandbox preset's scope). */
export function registerSandboxDependencies(ctx: Context, config: SandboxDependenciesConfig): void {
  const tools = (ctx as unknown as { tools: { register(definition: unknown): () => void } }).tools
  let cached: Promise<SandboxDependencies> | undefined
  tools.register(defineTool({
    name: 'load_workspace_dependencies',
    description: 'Get the Python, Node.js and pnpm of this sandbox (the Linux container this chat runs in), with the Python packages installed there. Everything you run executes inside the sandbox, so use these paths, or plain python3/node/pnpm on PATH. You may install more with pip or sudo apt-get.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          environment: { type: 'string', required: true, description: 'Always "sandbox": these are the container\'s own programs.' },
          python: { type: 'string', required: true, description: 'Empty when the image has no Python.' },
          pythonPackages: { type: 'string', required: true },
          pythonDistributions: { type: 'object', additionalProperties: true, required: true, description: 'Installed Python distributions and versions, including ones added since the sandbox started.' },
          node: { type: 'string', description: 'Absent when the image has no Node.js.' },
          nodePackages: { type: 'string', description: 'Global node_modules; absent without Node.js.' },
          pnpm: { type: 'string', description: 'Absent when the image has no pnpm.' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
    },
    execute: () => {
      cached ??= (async () => {
        const credentials = config.url && config.key ? { url: config.url, key: config.key } : sandboxCredentials()
        if (!credentials) throw new Error('this server has no Agentry Sandbox configured')
        const envd = createSandboxApi({ ...credentials, owner: config.owner }).envd(config.sandboxId)
        const r = await runInEnvd(envd, 'agent', PROBE, { cwd: config.workspace, timeoutMs: 30_000 })
        if (r.code !== 0) throw new Error(`could not read the sandbox's software (exit ${String(r.code)}): ${(r.stderr || r.stdout).trim().slice(-300)}`)
        return parseProbe(r.stdout, r.stderr)
      })().catch((error: unknown) => {
        cached = undefined
        throw error
      })
      // Installs happen during a chat, so the answer is reused only briefly.
      const result = cached
      setTimeout(() => { if (cached === result) cached = undefined }, 60_000).unref()
      return result
    },
    presentCall: () => ({ card: 'generic', title: 'Load sandbox dependencies', kind: 'read' }),
  }))
}
