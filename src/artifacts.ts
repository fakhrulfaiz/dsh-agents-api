/**
 * Session artifact listing and download.
 *
 * When S3 settings are present, reads `{prefix}sessions/{sessionId}/artifacts/...`.
 * Otherwise lists and reads files under the session workspace, rejecting paths
 * that escape it. `@aws-sdk/client-s3` loads only when that config is present.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/** One artifact entry returned by list. */
export interface ArtifactEntry {
  path: string
  size?: number
  last_modified?: string
}

/** Generic S3 settings. The endpoint may later be a Ceph RGW address. */
export interface ArtifactS3Config {
  endpoint: string
  bucket: string
  prefix: string
  region: string
  credentials: { accessKeyId: string; secretAccessKey: string }
}

interface S3ListItem {
  Key?: string
  Size?: number
  LastModified?: Date
}

interface S3ListResult {
  Contents?: S3ListItem[]
  IsTruncated?: boolean
  NextContinuationToken?: string
}

interface S3GetResult {
  Body?: { transformToByteArray(): Promise<Uint8Array> }
}

interface S3Module {
  S3Client: new (opts: Record<string, unknown>) => { send(command: unknown): Promise<S3ListResult & S3GetResult> }
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown
  GetObjectCommand: new (input: Record<string, unknown>) => unknown
}

/**
 * Object-key prefix for one session's presented artifacts.
 * @param config - S3 config.
 * @param sessionId - session id.
 * @returns key prefix ending with `/`.
 */
function artifactsKeyPrefix(config: ArtifactS3Config, sessionId: string): string {
  return `${config.prefix}sessions/${sessionId}/artifacts/`
}

/**
 * Load the S3 client package. Called only when artifact config is present.
 */
async function loadS3(): Promise<S3Module> {
  const specifier = '@aws-sdk/client-s3'
  return import(specifier) as Promise<S3Module>
}

/**
 * List artifact objects for a session from S3.
 * @param config - S3 config.
 * @param sessionId - session id.
 */
export async function listS3Artifacts(
  config: ArtifactS3Config,
  sessionId: string,
): Promise<ArtifactEntry[]> {
  const s3 = await loadS3()
  const client = new s3.S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: config.credentials,
  })
  const prefix = artifactsKeyPrefix(config, sessionId)
  const entries: ArtifactEntry[] = []
  let continuationToken: string | undefined
  for (;;) {
    const out = await client.send(new s3.ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: prefix,
      ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
    }))
    for (const item of out.Contents ?? []) {
      const key = item.Key
      if (key === undefined || key === prefix) continue
      const path = key.slice(prefix.length)
      if (path.length === 0 || path.endsWith('/')) continue
      entries.push({
        path,
        ...(item.Size !== undefined ? { size: item.Size } : {}),
        ...(item.LastModified !== undefined ? { last_modified: item.LastModified.toISOString() } : {}),
      })
    }
    if (out.IsTruncated !== true || out.NextContinuationToken === undefined) break
    continuationToken = out.NextContinuationToken
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return entries
}

/**
 * Download one artifact object from S3.
 * @param config - S3 config.
 * @param sessionId - session id.
 * @param relativePath - path relative to the session artifacts prefix.
 * @returns file bytes, or undefined when missing or unsafe.
 */
export async function getS3Artifact(
  config: ArtifactS3Config,
  sessionId: string,
  relativePath: string,
): Promise<Buffer | undefined> {
  const safe = sanitizeRelativePath(relativePath)
  if (safe === undefined) return undefined
  const s3 = await loadS3()
  const client = new s3.S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: config.credentials,
  })
  const key = `${artifactsKeyPrefix(config, sessionId)}${safe}`
  try {
    const out = await client.send(new s3.GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }))
    if (out.Body === undefined) return undefined
    return Buffer.from(await out.Body.transformToByteArray())
  } catch (error: unknown) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    const name = (error as { name?: string }).name
    if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return undefined
    throw error
  }
}

/**
 * Recursively list regular files under a workspace directory.
 * @param workspace - absolute session workspace path.
 */
export async function listWorkspaceArtifacts(workspace: string): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = []
  await walkWorkspace(workspace, workspace, entries)
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return entries
}

/**
 * Read one file from the session workspace.
 * @param workspace - absolute session workspace path.
 * @param relativePath - path relative to the workspace.
 * @returns file bytes, or undefined when missing or unsafe.
 */
export async function getWorkspaceArtifact(
  workspace: string,
  relativePath: string,
): Promise<Buffer | undefined> {
  const safe = sanitizeRelativePath(relativePath)
  if (safe === undefined) return undefined
  const absolute = resolve(workspace, ...safe.split('/'))
  const root = resolve(workspace)
  if (absolute !== root && !absolute.startsWith(root + sep)) return undefined
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return undefined
    return await readFile(absolute)
  } catch {
    return undefined
  }
}

/**
 * Reject empty, absolute, or traversal-bearing relative paths.
 * @param relativePath - raw path from the URL.
 * @returns a forward-slash relative path, or undefined when unsafe.
 */
export function sanitizeRelativePath(relativePath: string): string | undefined {
  const trimmed = relativePath.replace(/^\/+/u, '').trim()
  if (trimmed.length === 0) return undefined
  const parts = trimmed.replace(/\\/gu, '/').split('/')
  const safe: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') return undefined
    safe.push(part)
  }
  if (safe.length === 0) return undefined
  return safe.join('/')
}

/**
 * Walk a directory tree collecting regular files.
 * @param root - workspace root.
 * @param dir - current directory.
 * @param out - accumulator.
 */
async function walkWorkspace(root: string, dir: string, out: ArtifactEntry[]): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === '.' || name === '..' || name === '.git' || name === 'node_modules') continue
    const absolute = join(dir, name)
    let info
    try {
      info = await stat(absolute)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      await walkWorkspace(root, absolute, out)
      continue
    }
    if (!info.isFile()) continue
    out.push({
      path: relative(root, absolute).split(sep).join('/'),
      size: info.size,
      last_modified: info.mtime.toISOString(),
    })
  }
}
