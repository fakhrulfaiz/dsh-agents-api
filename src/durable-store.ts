/**
 * Durable Agents API records on the local filesystem.
 *
 * Layout under `dataDir`:
 * - `SCHEMA_VERSION`
 * - `agents/<id>.json`
 * - `environment-templates/<id>.json`
 * - `environments/<id>.json`
 *
 * Sessions, items, and turns stay in memory.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OAIAgent } from './types.ts'
import type { EnvironmentRecord, EnvironmentTemplate } from './environment-types.ts'

/** Current on-disk schema generation. */
export const AGENTS_STORE_SCHEMA_VERSION = 1

/**
 * JSON-file agent store under a single data directory.
 */
export class FsAgentsApiStore {
  readonly dataDir: string
  readonly #agentsDir: string
  readonly #schemaPath: string

  /**
   * @param dataDir - root directory owned by this plugin.
   */
  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.#agentsDir = join(dataDir, 'agents')
    this.#schemaPath = join(dataDir, 'SCHEMA_VERSION')
  }

  /**
   * Ensure the agents directory exists and the schema version is readable.
   */
  async open(): Promise<void> {
    await mkdir(this.#agentsDir, { recursive: true })
    let existing: string | undefined
    try {
      existing = (await readFile(this.#schemaPath, 'utf8')).trim()
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }
    if (existing === undefined || existing === '') {
      await writeFile(this.#schemaPath, `${String(AGENTS_STORE_SCHEMA_VERSION)}\n`, 'utf8')
      return
    }
    const version = Number(existing)
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(`invalid agents store SCHEMA_VERSION at ${this.#schemaPath}: ${existing}`)
    }
    if (version > AGENTS_STORE_SCHEMA_VERSION) {
      throw new Error(
        `agents store schema ${String(version)} is newer than this plugin (${String(AGENTS_STORE_SCHEMA_VERSION)})`,
      )
    }
  }

  /**
   * @returns all agents found under `agents/`.
   */
  async loadAll(): Promise<OAIAgent[]> {
    await this.open()
    const records = await loadJsonMap<OAIAgent>(this.#agentsDir, 'agent')
    return [...records.values()]
  }

  /**
   * @param agent - record to write atomically.
   */
  async putAgent(agent: OAIAgent): Promise<void> {
    await this.open()
    await putJson(this.#agentsDir, agent.id, agent)
  }

  /**
   * @param id - agent id.
   * @returns whether a file was removed.
   */
  async deleteAgent(id: string): Promise<boolean> {
    await this.open()
    return deleteJson(this.#agentsDir, id)
  }
}

/**
 * JSON-file environment store under the same data directory.
 */
export class FsEnvironmentApiStore {
  readonly dataDir: string
  readonly #templatesDir: string
  readonly #environmentsDir: string

  /**
   * @param dataDir - root directory owned by this plugin.
   */
  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.#templatesDir = join(dataDir, 'environment-templates')
    this.#environmentsDir = join(dataDir, 'environments')
  }

  /** Ensure template and environment directories exist. */
  async open(): Promise<void> {
    await mkdir(this.#templatesDir, { recursive: true })
    await mkdir(this.#environmentsDir, { recursive: true })
  }

  /** @returns saved templates. */
  async loadTemplates(): Promise<EnvironmentTemplate[]> {
    await this.open()
    return [...(await loadJsonMap<EnvironmentTemplate>(this.#templatesDir, 'template')).values()]
  }

  /**
   * @param template - template to write.
   */
  async putTemplate(template: EnvironmentTemplate): Promise<void> {
    await this.open()
    await putJson(this.#templatesDir, template.id, template)
  }

  /**
   * @param id - template id.
   * @returns whether a file was removed.
   */
  async deleteTemplate(id: string): Promise<boolean> {
    await this.open()
    return deleteJson(this.#templatesDir, id)
  }

  /** @returns live environment records. */
  async loadEnvironments(): Promise<EnvironmentRecord[]> {
    await this.open()
    return [...(await loadJsonMap<EnvironmentRecord>(this.#environmentsDir, 'environment')).values()]
  }

  /**
   * @param env - environment record to write.
   */
  async putEnvironment(env: EnvironmentRecord): Promise<void> {
    await this.open()
    await putJson(this.#environmentsDir, env.id, env)
  }

  /**
   * @param id - environment id.
   * @returns whether a file was removed.
   */
  async deleteEnvironment(id: string): Promise<boolean> {
    await this.open()
    return deleteJson(this.#environmentsDir, id)
  }
}

/**
 * Load every `*.json` file in a directory into a map keyed by record id.
 * @param dir - directory to scan.
 * @param label - noun used in error messages.
 */
async function loadJsonMap<T extends { id: string }>(dir: string, label: string): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return out
    throw error
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const raw = await readFile(join(dir, name), 'utf8')
    const record = JSON.parse(raw) as T
    if (typeof record.id !== 'string' || record.id === '') {
      throw new Error(`${label} file ${name} is missing id`)
    }
    out.set(record.id, record)
  }
  return out
}

/**
 * Atomically write one JSON record.
 * @param dir - target directory.
 * @param id - file stem.
 * @param record - value to serialize.
 */
async function putJson(dir: string, id: string, record: unknown): Promise<void> {
  const target = join(dir, `${id}.json`)
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

/**
 * Remove one JSON record file.
 * @param dir - target directory.
 * @param id - file stem.
 * @returns whether a file was removed.
 */
async function deleteJson(dir: string, id: string): Promise<boolean> {
  const target = join(dir, `${id}.json`)
  try {
    await rm(target)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    throw error
  }
}
