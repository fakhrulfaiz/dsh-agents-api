/**
 * Optional Agents API paths and backends.
 *
 * The workspaces root comes only from plugin config (`workspaces`). The S3
 * artifact backend takes config, then env vars, and stays off until endpoint
 * and credentials are all set.
 * Codebox is parked: its settings are rejected, never ignored.
 */

import type { ArtifactS3Config } from './artifacts.ts'

/** Plugin fields this resolver reads. */
export interface RuntimeConfigInput {
  /** Root of `<owner>/<session>/` session workspaces and `<owner>/<environment>/` local environments. Required. */
  workspaces: string
  artifacts?: {
    endpoint?: string
    bucket?: string
    prefix?: string
    region?: string
    accessKeyId?: string
    secretAccessKey?: string
  }
}

/** Resolved optional backends for one plugin apply. */
export interface RuntimeConfig {
  /** Directory holding `<owner>/<session>/` default session workspaces and `<owner>/<environment>/` local environments. */
  workspacesRoot: string
  /** Generic S3 artifact endpoint, or omitted so reads use the session cwd. */
  artifacts?: ArtifactS3Config
}

/** Env vars that would configure the parked Codebox backend. */
const CODEBOX_ENV = ['CODEBOX_BASE_URL', 'CODEBOX_API_KEY'] as const

/** Codebox settings were supplied while Codebox environments are disabled. */
export class CodeboxDisabledError extends Error {
  /** @param source - config field or env var that set them. */
  constructor(source: string) {
    super(`agents-api: Codebox environments are disabled until per-session execution exists; remove ${source}`)
    this.name = 'CodeboxDisabledError'
  }
}

/**
 * Trim a string and treat blanks as missing.
 * @param value - raw config or env value.
 * @returns the trimmed string, or undefined.
 */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? undefined : trimmed
}

/**
 * Normalize an object-key prefix to a trailing slash, or the empty root.
 * @param prefix - raw prefix.
 * @returns normalized prefix.
 */
function normalizePrefix(prefix: string): string {
  if (prefix === '') return ''
  return `${prefix.replace(/^\/+/u, '').replace(/\/+$/u, '')}/`
}

/**
 * Resolve the workspaces root from config and the optional backends from config, then process env, then off.
 * @param config - validated plugin config.
 * @param env - process environment, injectable in tests.
 * @returns the workspaces root and the backends that are actually configured.
 * @throws CodeboxDisabledError when a Codebox env var is set.
 * @throws Error when `workspaces` is missing or blank.
 */
export function resolveRuntimeConfig(
  config: RuntimeConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const codeboxVar = CODEBOX_ENV.find(name => text(env[name]) !== undefined)
  if (codeboxVar !== undefined) throw new CodeboxDisabledError(`env ${codeboxVar}`)
  const workspacesRoot = text(config.workspaces)
  if (workspacesRoot === undefined) throw new Error('agents-api: "workspaces" is required (root directory for session workspaces and local environments)')
  const endpoint = text(config.artifacts?.endpoint) ?? text(env['SEAWEEDFS_ENDPOINT'])
  const accessKeyId = text(config.artifacts?.accessKeyId) ?? text(env['AWS_ACCESS_KEY_ID'])
  const secretAccessKey = text(config.artifacts?.secretAccessKey) ?? text(env['AWS_SECRET_ACCESS_KEY'])
  const runtime: RuntimeConfig = { workspacesRoot }
  if (endpoint !== undefined && accessKeyId !== undefined && secretAccessKey !== undefined) {
    const bucket = text(config.artifacts?.bucket) ?? text(env['SEAWEEDFS_BUCKET']) ?? 'dsh-session'
    const prefix = text(config.artifacts?.prefix) ?? text(env['DSH_SESSION_S3_PREFIX']) ?? ''
    const region = text(config.artifacts?.region)
      ?? text(env['AWS_REGION'])
      ?? text(env['AWS_DEFAULT_REGION'])
      ?? 'us-east-1'
    runtime.artifacts = {
      endpoint,
      bucket,
      prefix: normalizePrefix(prefix),
      region,
      credentials: { accessKeyId, secretAccessKey },
    }
  }
  return runtime
}
