/**
 * Agent definitions to a draft `CreateAgentParams` (nothing is saved here):
 *
 * - Claude Code / ECC agent files: YAML front matter (`name`, `description`, `tools`, `model`) and a Markdown body (the prompt).
 *   Agentry's own library files add optional hints: `title` (display name), `subagents: true`, `browser: true|false`,
 *   `apps` (Composio toolkit slugs, each granted in full) and `icon`/`color` (the avatar, kept in metadata).
 * - Agentry agent JSON (the `GET /agents/{id}` shape; `id`, timestamps and masked MCP tools are dropped).
 */
import { parse as parseYaml } from 'yaml'
import type { CreateAgentParams, OAIToolConfig } from '../types.ts'

/** Largest accepted instructions, the preset's `agent-instructions` limit. */
export const MAX_INSTRUCTIONS_BYTES = 65_536

/** Claude Code tool names to Host tool names. `Task` (subagents) turns on `multi_agent` instead. */
export const CLAUDE_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  Grep: 'grep',
  Glob: 'glob',
  Bash: 'bash',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
}

export type ImportErrorCode = 'import_unrecognized' | 'import_too_large' | 'import_host_not_allowed' | 'import_fetch_failed' | 'import_not_found'

/** An import that cannot become a draft; `code` is the wire error code. */
export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode, message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

/** A draft agent: `CreateAgentParams` without a required model (the form uses the user's default). */
export type AgentDraft = Omit<CreateAgentParams, 'model'> & { model?: string }

export interface ParsedAgent {
  draft: AgentDraft
  format: 'ecc' | 'agentry'
  notes: string[]
}

const UNRECOGNIZED = 'This file is not an agent definition. Expected a Markdown file with name and description at the top, or an Agentry agent JSON.'

/** `code-reviewer` → "Code reviewer". */
export function titleFromSlug(name: string): string {
  const words = name.trim().replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Front matter and body of a Markdown file, or `undefined` without front matter. */
export function splitFrontMatter(text: string): { data: Record<string, unknown>; body: string } | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text)
  if (match === null) return undefined
  let data: unknown
  try {
    data = parseYaml(match[1] ?? '')
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length) }
}

function checkInstructions(instructions: string): void {
  if (Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
    throw new ImportError('import_too_large', `The instructions are longer than ${String(MAX_INSTRUCTIONS_BYTES)} bytes.`)
  }
}

function toolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
  return String(value).split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * @param text - an ECC / Claude Code agent file.
 * @param catalog - Host tool names this server has (`GET /agents/tools`).
 */
function fromMarkdown(text: string, catalog: ReadonlySet<string>): ParsedAgent | undefined {
  const split = splitFrontMatter(text)
  if (split === undefined) return undefined
  const { data, body } = split
  if (typeof data['name'] !== 'string' || data['name'].trim() === '' || typeof data['description'] !== 'string') return undefined
  const instructions = body.trim()
  checkInstructions(instructions)
  const notes: string[] = []
  const title = typeof data['title'] === 'string' && data['title'].trim() !== '' ? data['title'].trim() : undefined
  const draft: AgentDraft = {
    name: title ?? titleFromSlug(data['name']),
    instructions,
    metadata: {
      description: data['description'].trim().slice(0, 512),
      // Agentry library files name an avatar.
      ...(typeof data['icon'] === 'string' && data['icon'] !== '' ? { icon: data['icon'] } : {}),
      ...(typeof data['color'] === 'string' && data['color'] !== '' ? { color: data['color'] } : {}),
    },
  }
  const tools = toolList(data['tools'])
  if (tools !== undefined) {
    const allow = new Set<string>()
    const dropped: string[] = []
    for (const tool of tools) {
      if (tool === 'Task') {
        draft.multi_agent = { enabled: true }
        continue
      }
      const mapped = CLAUDE_TOOL_MAP[tool] ?? (catalog.has(tool) ? tool : undefined)
      if (mapped === undefined || !catalog.has(mapped)) dropped.push(tool)
      else allow.add(mapped)
    }
    draft.host_tools = { allow: [...allow] }
    if (dropped.length > 0) notes.push(`Dropped tools this server does not have: ${dropped.join(', ')}.`)
  }
  if (data['subagents'] === true) draft.multi_agent = { enabled: true }
  if (typeof data['browser'] === 'boolean') draft.browser = data['browser']
  const apps = toolList(data['apps'])?.filter(slug => /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(slug))
  if (apps !== undefined && apps.length > 0) draft.apps = Object.fromEntries(apps.map(slug => [slug, 'all' as const]))
  if (typeof data['model'] === 'string' && data['model'].trim() !== '') {
    notes.push(`The file asks for model "${data['model'].trim()}"; the agent uses your default model instead. Pick one in the form.`)
  }
  return { draft, format: 'ecc', notes }
}

const MASK = '***'

function masked(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.values(value as Record<string, unknown>).some(v => v === MASK)
}

/**
 * @param text - an Agentry agent JSON.
 * @param catalog - Host tool names this server has.
 */
function fromJson(text: string, catalog: ReadonlySet<string>): ParsedAgent | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const agent = raw as Record<string, unknown>
  if (typeof agent['instructions'] !== 'string' && typeof agent['name'] !== 'string') return undefined
  if (agent['object'] !== undefined && agent['object'] !== 'agent') return undefined
  const notes: string[] = []
  const draft: AgentDraft = {}
  if (typeof agent['name'] === 'string') draft.name = agent['name']
  if (typeof agent['instructions'] === 'string') {
    checkInstructions(agent['instructions'])
    draft.instructions = agent['instructions']
  }
  if (typeof agent['model'] === 'string' && agent['model'] !== '') draft.model = agent['model']
  const metadata = agent['metadata']
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    draft.metadata = Object.fromEntries(Object.entries(metadata as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  }
  const hostTools = agent['host_tools'] as { allow?: unknown; deny?: unknown } | null | undefined
  if (hostTools && typeof hostTools === 'object') {
    const pick = (list: unknown) => Array.isArray(list) ? list.map(String).filter(name => catalog.has(name)) : undefined
    const allow = pick(hostTools.allow)
    const deny = pick(hostTools.deny)
    const missing = [...(Array.isArray(hostTools.allow) ? hostTools.allow : []), ...(Array.isArray(hostTools.deny) ? hostTools.deny : [])].map(String).filter(name => !catalog.has(name))
    draft.host_tools = { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) }
    if (missing.length > 0) notes.push(`Dropped tools this server does not have: ${missing.join(', ')}.`)
  }
  const multi = agent['multi_agent'] as { enabled?: unknown } | null | undefined
  if (multi && typeof multi === 'object' && typeof multi.enabled === 'boolean') draft.multi_agent = { enabled: multi.enabled }
  const reasoning = agent['reasoning'] as { effort?: unknown } | null | undefined
  if (reasoning && typeof reasoning === 'object' && typeof reasoning.effort === 'string') draft.reasoning = { effort: reasoning.effort } as never
  const apps = agent['apps']
  if (apps !== null && typeof apps === 'object' && !Array.isArray(apps)
    && Object.values(apps as Record<string, unknown>).every(v => v === 'all' || (Array.isArray(v) && v.every(s => typeof s === 'string')))) {
    draft.apps = apps as NonNullable<CreateAgentParams['apps']>
  }
  if (agent['send_policy'] === 'ask' || agent['send_policy'] === 'auto') draft.send_policy = agent['send_policy']
  if (typeof agent['browser'] === 'boolean') draft.browser = agent['browser']
  if (Array.isArray(agent['tools'])) {
    const kept: OAIToolConfig[] = []
    let droppedMasked = 0
    for (const tool of agent['tools'] as Array<Record<string, unknown>>) {
      if (tool === null || typeof tool !== 'object') continue
      const transport = tool['transport'] as Record<string, unknown> | undefined
      if (tool['type'] === 'mcp' && (masked(transport?.['headers']) || masked(transport?.['env']))) {
        droppedMasked += 1
        continue
      }
      kept.push(tool as unknown as OAIToolConfig)
    }
    if (kept.length > 0) draft.tools = kept
    if (droppedMasked > 0) notes.push(`Left out ${String(droppedMasked)} MCP server(s) whose credentials were hidden in the export; add them again with their keys.`)
  }
  return { draft, format: 'agentry', notes }
}

/**
 * @param text - file content (Markdown with front matter, or JSON).
 * @param catalog - Host tool names this server has.
 * @throws ImportError `import_unrecognized` or `import_too_large`.
 */
export function parseAgentDefinition(text: string, catalog: ReadonlySet<string>): ParsedAgent {
  const trimmed = text.trimStart()
  const parsed = trimmed.startsWith('{') ? fromJson(trimmed, catalog) : fromMarkdown(text, catalog)
  if (parsed === undefined) throw new ImportError('import_unrecognized', UNRECOGNIZED)
  return parsed
}
