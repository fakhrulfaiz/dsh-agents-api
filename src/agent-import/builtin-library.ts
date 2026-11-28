/**
 * Agentry's built-in agent Library: the Markdown agent files in `./agent-library/` (adapted from ECC, see its
 * `NOTICE.md`), read once at startup and parsed with the import parser. Served at
 * `GET /agents/library/builtin` for the web app's Library and read by the `library_search` and `library_add`
 * tools. The build copies the folder to `lib/agent-library`, beside the bundle, like the migrations.
 *
 * Each item: `{ ref, source: 'Agentry', name, slug, description, origin?, icon?, color?, browser?, subagents?,
 * apps?, text, draft }`; `ref` (`Agentry:<file>`) is what an agent added from it keeps in `metadata.library_ref`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'node:http'
import type { Route } from '../gateway.ts'
import { json } from '../http.ts'
import { type AgentDraft, parseAgentDefinition, splitFrontMatter } from './parse.ts'

/** The built-in source's label (a user source may not take it). */
export const BUILTIN_SOURCE = 'Agentry'

/** Where the built-in files live: `src/agent-import/agent-library` in a checkout, `lib/agent-library` in a build. */
export const BUILTIN_LIBRARY_DIR = fileURLToPath(new URL('./agent-library/', import.meta.url))

/** One built-in Library agent. */
export interface BuiltinLibraryItem {
  ref: string
  source: typeof BUILTIN_SOURCE
  name: string
  slug: string
  description: string
  /** The ECC original (front matter `source`). */
  origin?: string
  icon?: string
  color?: string
  browser?: boolean
  subagents?: boolean
  apps?: string[]
  /** The file's full text. */
  text: string
  /** The agent the file describes, as `POST /agents/import` drafts it. */
  draft: AgentDraft
}

/** `<label>:<file or URL>`, the value kept in `metadata.library_ref`. */
export const refOf = (label: string, path: string): string => `${label}:${path}`.slice(0, 512)

/**
 * The name an added agent starts with: `name`, or "<name> (<source label>)" when the owner already has an agent
 * called `name` (then a number when that is taken too). Case-insensitive. The web app's Add uses the same rule.
 */
export function nameForAdd(name: string, label: string, existing: readonly string[]): string {
  const taken = new Set(existing.map(n => n.trim().toLowerCase()))
  if (!taken.has(name.trim().toLowerCase())) return name
  const base = `${name} (${label})`
  let candidate = base
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${String(n)}`
  return candidate
}

/** The raw built-in files (name and text), sorted by file name; `NOTICE.md` is not an agent. */
export function readBuiltinFiles(dir: string = BUILTIN_LIBRARY_DIR): Array<{ file: string; text: string }> {
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'NOTICE.md')
    .sort()
    .map(file => ({ file, text: readFileSync(`${dir.replace(/\/?$/u, '/')}${file}`, 'utf8') }))
}

/**
 * Parse the built-in files into Library items, sorted by name.
 * @param files - file names and texts (`readBuiltinFiles`).
 * @param catalog - Host tool names; tools the server lacks are dropped from the drafts.
 * @throws ImportError when a file is not an agent definition.
 */
export function builtinLibrary(files: ReadonlyArray<{ file: string; text: string }>, catalog: ReadonlySet<string>): BuiltinLibraryItem[] {
  return files.map(({ file, text }): BuiltinLibraryItem => {
    const { draft } = parseAgentDefinition(text, catalog)
    const front = splitFrontMatter(text)?.data ?? {}
    const string = (key: string) => (typeof front[key] === 'string' && front[key] !== '' ? front[key] : undefined)
    const apps = draft.apps ? Object.keys(draft.apps) : []
    const origin = string('source')
    const icon = string('icon')
    const color = string('color')
    return {
      ref: refOf(BUILTIN_SOURCE, file),
      source: BUILTIN_SOURCE,
      name: draft.name ?? file,
      slug: file.replace(/\.md$/u, ''),
      description: String(draft.metadata?.['description'] ?? ''),
      ...(origin ? { origin } : {}),
      ...(icon ? { icon } : {}),
      ...(color ? { color } : {}),
      ...(draft.browser === true ? { browser: true } : {}),
      ...(draft.multi_agent?.enabled === true ? { subagents: true } : {}),
      ...(apps.length > 0 ? { apps } : {}),
      text,
      draft,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** `GET /agents/library/builtin`. */
export class BuiltinLibraryApi {
  readonly #files: ReadonlyArray<{ file: string; text: string }>

  /**
   * @param catalog - Host tool names, read per request (the preset registers after startup).
   * @param files - the built-in files; defaults to the shipped folder.
   */
  constructor(private readonly catalog: () => Promise<ReadonlySet<string>>, files?: ReadonlyArray<{ file: string; text: string }>) {
    this.#files = files ?? readBuiltinFiles()
  }

  /** The parsed Library with the server's current tool catalog. */
  async items(): Promise<BuiltinLibraryItem[]> {
    return builtinLibrary(this.#files, await this.catalog())
  }

  routes(): Route[] {
    return [{ method: 'GET', pattern: '/agents/library/builtin', handler: (_req, res) => this.list(res) }]
  }

  private async list(res: ServerResponse): Promise<void> {
    json(res, 200, { object: 'list', data: await this.items() })
  }
}
