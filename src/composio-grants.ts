/**
 * Per-agent Composio app grants: which connected apps, and which of their
 * tools, an agent may call. Checked on every Composio MCP call, including
 * each call inside a `COMPOSIO_MULTI_EXECUTE_TOOL` batch.
 */

import type { AgentAppGrants, OAIAgent } from './types.ts'

export type { AgentAppGrants }

const TOOLKIT = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const TOOL_SLUG = /^[A-Z0-9][A-Z0-9_]*$/u
/** Meta tools that only discover tools; their calls always run, and `filterSearchResult` trims what they list. */
const DISCOVERY = new Set(['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_GET_TOOLKITS'])
const MULTI = 'COMPOSIO_MULTI_EXECUTE_TOOL'
const CONNECTIONS = 'COMPOSIO_MANAGE_CONNECTIONS'

/**
 * An agent's grants: `apps` when set; else the legacy `metadata.connectors` list
 * (each app with all its tools); else `null` (unrestricted).
 */
export function effectiveGrants(agent: Pick<OAIAgent, 'metadata'> & { apps?: AgentAppGrants | null } | undefined): AgentAppGrants | null {
  if (agent === undefined) return null
  if (agent.apps !== undefined && agent.apps !== null) return agent.apps
  const legacy = (agent.metadata?.connectors ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return legacy.length === 0 ? null : Object.fromEntries(legacy.map(slug => [slug, 'all' as const]))
}

/** @returns a readable app name from a toolkit slug or a tool slug's first word. */
function appName(slug: string): string {
  const word = slug.toLowerCase().split('_')[0] ?? slug
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * @param toolSlug - e.g. `GOOGLECALENDAR_CREATE_EVENT`.
 * @param known - toolkit slugs to match.
 * @returns the longest known toolkit whose uppercased slug plus `_` prefixes the tool slug.
 */
export function toolkitOf(toolSlug: string, known: readonly string[]): string | undefined {
  let best: string | undefined
  for (const toolkit of known) {
    const prefix = `${toolkit.toUpperCase().replaceAll('-', '_')}_`
    if (toolSlug.startsWith(prefix) && (best === undefined || toolkit.length > best.length)) best = toolkit
  }
  return best
}

/**
 * Tool slugs a call runs.
 * @param rawName - the tool name after `mcp__<server>__`.
 * @param args - call arguments.
 * @returns the slugs (empty for meta tools), or `'malformed'` for a batch without a readable `tools` list.
 */
export function slugsInCall(rawName: string, args: unknown): string[] | 'malformed' {
  if (rawName === MULTI) {
    const tools = (args as { tools?: unknown } | null)?.tools
    if (!Array.isArray(tools)) return 'malformed'
    const slugs: string[] = []
    for (const entry of tools) {
      const slug = (entry as { tool_slug?: unknown } | null)?.tool_slug
      if (typeof slug !== 'string') return 'malformed'
      slugs.push(slug)
    }
    return slugs
  }
  if (rawName.startsWith('COMPOSIO_')) return []
  return [rawName]
}

/**
 * @param slug - tool slug.
 * @param grants - agent grants (non-null).
 * @returns a refusal, or `undefined` when granted.
 */
function checkSlug(slug: string, grants: AgentAppGrants): string | undefined {
  const toolkit = toolkitOf(slug, Object.keys(grants))
  const grant = toolkit === undefined ? undefined : grants[toolkit]
  if (grant === 'all' || (Array.isArray(grant) && grant.includes(slug))) return undefined
  return `This agent is not allowed to use ${appName(toolkit ?? slug)} (${slug}).`
}

/**
 * @param rawName - Composio tool name (after `mcp__<server>__`).
 * @param args - call arguments.
 * @param grants - the agent's grants; `null` allows everything.
 * @returns a refusal naming the refused app only, or `undefined`.
 */
export function checkComposioCall(rawName: string, args: unknown, grants: AgentAppGrants | null): string | undefined {
  if (grants === null) return undefined
  if (DISCOVERY.has(rawName)) return undefined
  if (rawName === CONNECTIONS) {
    const toolkits = (args as { toolkits?: unknown } | null)?.toolkits
    const names = Array.isArray(toolkits) ? toolkits.map(t => (typeof t === 'string' ? t : (t as { name?: unknown } | null)?.name)) : []
    for (const name of names) {
      if (typeof name !== 'string' || !(name.toLowerCase() in grants)) return `This agent is not allowed to use ${appName(String(name))} (${String(name)}).`
    }
    return undefined
  }
  const slugs = slugsInCall(rawName, args)
  if (slugs === 'malformed') return 'This agent can only run app tools it is allowed to use; the batch did not name its tools.'
  for (const slug of slugs) {
    const refusal = checkSlug(slug, grants)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

/**
 * @param slug - tool slug.
 * @param verbs - write verbs (UPPER) that need approval when they appear as a slug word.
 * @param explicit - extra slugs that always need approval.
 * @returns whether calling the slug writes on the user's behalf.
 */
export function isWriteSlug(slug: string, verbs: ReadonlySet<string>, explicit: ReadonlySet<string>): boolean {
  return explicit.has(slug) || slug.split('_').some(word => verbs.has(word))
}

/**
 * Limit a requested grant to the caller's own.
 * @param requested - grants the new or updated agent asks for; `null` asks for everything.
 * @param caller - the calling agent's grants; `null` is unrestricted.
 * @returns the clamped grants.
 */
export function clampGrants(requested: AgentAppGrants | null, caller: AgentAppGrants | null): AgentAppGrants | null {
  if (caller === null) return requested
  if (requested === null) return { ...caller }
  const out: AgentAppGrants = {}
  for (const [toolkit, want] of Object.entries(requested)) {
    const have = caller[toolkit]
    if (have === undefined) continue
    if (have === 'all') out[toolkit] = want
    else if (want === 'all') out[toolkit] = [...have]
    else out[toolkit] = want.filter(slug => have.includes(slug))
  }
  return out
}

/**
 * @param value - a request's `apps` field.
 * @returns an error message, or `undefined` when valid.
 */
export function validateAppGrants(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return 'apps must be null or an object of app slug to "all" or a list of tool slugs'
  for (const [toolkit, grant] of Object.entries(value as Record<string, unknown>)) {
    if (!TOOLKIT.test(toolkit)) return `apps: "${toolkit}" is not an app slug`
    if (grant === 'all') continue
    if (!Array.isArray(grant)) return `apps.${toolkit} must be "all" or a list of tool slugs`
    for (const slug of grant) if (typeof slug !== 'string' || !TOOL_SLUG.test(slug)) return `apps.${toolkit}: "${String(slug)}" is not a tool slug`
  }
  return undefined
}

const SLUG_LIST_KEY = /tool_slugs$/u
const MAP_KEY = /^(tool_schemas|toolkit_schemas)$/u

/**
 * Drops the tools and apps the agent may not use from a `COMPOSIO_SEARCH_TOOLS` answer, so the model is not shown
 * (and does not plan around) tools every call of which would be refused. Works on the JSON body generically: slug
 * lists (`*_tool_slugs`, `toolkits`), `tool_schemas` / `toolkit_schemas` maps, and objects carrying `tool_slug` or `toolkit`.
 * @param text - the tool result's text.
 * @param grants - the agent's grants; `null` keeps everything.
 * @returns the trimmed text, or `undefined` when nothing changed or the text is not a JSON object.
 */
export function filterSearchResult(text: string, grants: AgentAppGrants | null): string | undefined {
  if (grants === null) return undefined
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const toolOk = (slug: string): boolean => checkSlug(slug, grants) === undefined
  const appOk = (name: string): boolean => name.toLowerCase() in grants
  let changed = false
  const walk = (node: unknown, key: string): unknown => {
    if (Array.isArray(node)) {
      const out: unknown[] = []
      for (const item of node) {
        if (typeof item === 'string' && SLUG_LIST_KEY.test(key) && !toolOk(item)) { changed = true; continue }
        if (typeof item === 'string' && key === 'toolkits' && !appOk(item)) { changed = true; continue }
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const o = item as Record<string, unknown>
          if (typeof o['tool_slug'] === 'string' && !toolOk(o['tool_slug'])) { changed = true; continue }
          if (typeof o['toolkit'] === 'string' && !appOk(o['toolkit'])) { changed = true; continue }
        }
        out.push(walk(item, key))
      }
      return out
    }
    if (typeof node === 'object' && node !== null) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node)) {
        if (MAP_KEY.test(key) && ((key === 'tool_schemas' && !toolOk(k)) || (key === 'toolkit_schemas' && !appOk(k)))) { changed = true; continue }
        out[k] = walk(v, k)
      }
      return out
    }
    return node
  }
  const filtered = walk(body, '')
  return changed ? JSON.stringify(filtered) : undefined
}
