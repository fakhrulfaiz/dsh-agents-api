/**
 * Optional Agents API paths and backends.
 *
 * Every field stays off when both plugin config and the matching env var are
 * empty. This machine's `.env` sets local directories only; Codebox and S3
 * stay unset until an operator fills them in.
 */

import type { ArtifactS3Config } from './artifacts.ts'
import type { CodeboxSettings } from './codebox-client.ts'

/** Plugin fields this resolver reads. All of them are optional. */
export interface RuntimeConfigInput {
  dataDir?: string
  workspaces?: string
  codebox?: {
    baseUrl?: string
    apiKey?: string
    image?: string
    readyTimeoutSeconds?: number
    budgetInstanceId?: string
  }
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
  /** Durable JSON root, or omitted for a RAM-only agent directory. */
  dataDir?: string
  /** Directory used when a session does not pass an absolute cwd. */
  workspacesRoot?: string
  /** Codebox HTTP control plane, or omitted so new environments are local directories. */
  codebox?: CodeboxSettings
  /** Generic S3 artifact endpoint, or omitted so reads use the session cwd. */
  artifacts?: ArtifactS3Config
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
 * Resolve plugin config, then process env, then off.
 * @param config - validated plugin config.
 * @param env - process environment, injectable in tests.
 * @returns backends that are actually configured.
 */
export function resolveRuntimeConfig(
  config: RuntimeConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const dataDir = text(config.dataDir) ?? text(env['AGENTS_API_DATA_DIR'])
  const workspacesRoot = text(config.workspaces) ?? text(env['AGENTS_API_WORKSPACES'])
  const codeboxBase = text(config.codebox?.baseUrl) ?? text(env['CODEBOX_BASE_URL'])
  const codeboxKey = text(config.codebox?.apiKey) ?? text(env['CODEBOX_API_KEY'])
  const endpoint = text(config.artifacts?.endpoint) ?? text(env['SEAWEEDFS_ENDPOINT'])
  const accessKeyId = text(config.artifacts?.accessKeyId) ?? text(env['AWS_ACCESS_KEY_ID'])
  const secretAccessKey = text(config.artifacts?.secretAccessKey) ?? text(env['AWS_SECRET_ACCESS_KEY'])
  const timeoutRaw = config.codebox?.readyTimeoutSeconds
    ?? Number(env['CODEBOX_READY_TIMEOUT_SECONDS'] ?? '')
  const readyTimeoutSeconds = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined
  const image = text(config.codebox?.image) ?? text(env['CODEBOX_IMAGE'])
  const budgetInstanceId = text(config.codebox?.budgetInstanceId) ?? text(env['CODEBOX_BUDGET_INSTANCE_ID'])
  const runtime: RuntimeConfig = {}
  if (dataDir !== undefined) runtime.dataDir = dataDir
  if (workspacesRoot !== undefined) runtime.workspacesRoot = workspacesRoot
  if (codeboxBase !== undefined && codeboxKey !== undefined) {
    runtime.codebox = {
      baseUrl: codeboxBase,
      apiKey: codeboxKey,
      ...(image !== undefined ? { image } : {}),
      ...(readyTimeoutSeconds !== undefined ? { readyTimeoutSeconds } : {}),
      ...(budgetInstanceId !== undefined ? { budgetInstanceId } : {}),
    }
  }
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
