/**
 * Upload settings (`uploads` in the plugin config) and their validation.
 */

import { resolve, sep } from 'node:path'

/** Resolved `uploads` block: every field present after `Config` defaults, except `dir`. */
export interface UploadsConfig {
  /** Staging directory for uploaded bytes. Outside `workspaces`. Uploads are disabled when blank or absent. */
  dir?: string
  /** Largest accepted file, in bytes. */
  maxFileBytes: number
  /** Most files one message may carry. */
  maxFilesPerMessage: number
  /** Largest total bytes of the files of one message. */
  maxMessageBytes: number
  /** Largest total bytes one owner may keep staged. */
  maxStagedBytesPerOwner: number
  /** Minutes a staged file survives before the sweeper removes it. */
  stagedTtlMinutes: number
  /** Minutes between sweeps. */
  sweepIntervalMinutes: number
  /** Media types accepted at upload. */
  allowedMediaTypes: string[]
}

/** Limits the upload and send paths enforce. */
export type UploadLimits = Pick<UploadsConfig, 'maxFileBytes' | 'maxFilesPerMessage' | 'maxMessageBytes' | 'maxStagedBytesPerOwner' | 'allowedMediaTypes'>

/** Default for `uploads.allowedMediaTypes`: rasters DSH can show to a vision model, PDF, text, CSV, JSON, and ZIP-based Office files. */
export const DEFAULT_ALLOWED_MEDIA_TYPES: readonly string[] = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]

/** `type/subtype`, lowercase. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u

/**
 * Check the `uploads` block for values the upload path cannot work with.
 * @param uploads - resolved block.
 * @throws when a size, count, or interval is not a positive integer, `maxMessageBytes` is below `maxFileBytes`, `maxStagedBytesPerOwner` is below `maxFileBytes`, or `allowedMediaTypes` is empty or holds a malformed entry.
 */
export function validateUploads(uploads: UploadsConfig): void {
  const positive: Array<keyof UploadsConfig> = ['maxFileBytes', 'maxFilesPerMessage', 'maxMessageBytes', 'maxStagedBytesPerOwner', 'stagedTtlMinutes', 'sweepIntervalMinutes']
  for (const key of positive) {
    const value = uploads[key] as number
    if (!Number.isInteger(value) || value < 1) throw new Error(`agents-api: "uploads.${key}" must be a positive integer`)
  }
  if (uploads.maxMessageBytes < uploads.maxFileBytes) throw new Error('agents-api: "uploads.maxMessageBytes" must be at least "uploads.maxFileBytes"')
  if (uploads.maxStagedBytesPerOwner < uploads.maxFileBytes) throw new Error('agents-api: "uploads.maxStagedBytesPerOwner" must be at least "uploads.maxFileBytes"')
  if (uploads.allowedMediaTypes.length === 0) throw new Error('agents-api: "uploads.allowedMediaTypes" must not be empty')
  const bad = uploads.allowedMediaTypes.filter(type => !MEDIA_TYPE.test(type))
  if (bad.length > 0) throw new Error(`agents-api: "uploads.allowedMediaTypes" has malformed entries: ${bad.join(', ')}`)
}

/**
 * Resolve the staging directory.
 * @param uploads - validated block.
 * @param workspacesRoot - absolute-or-relative workspaces root.
 * @returns the absolute staging directory, or `undefined` when uploads are disabled (`dir` absent or blank).
 * @throws when the staging directory lies inside the workspaces root or contains it: a sandboxed agent could read other users' staged files.
 */
export function stagingDirectory(uploads: UploadsConfig, workspacesRoot: string): string | undefined {
  const dir = uploads.dir?.trim() ?? ''
  if (dir === '') return undefined
  const staging = resolve(dir)
  const workspaces = resolve(workspacesRoot)
  const inside = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(outer + sep)
  if (inside(workspaces, staging) || inside(staging, workspaces)) {
    throw new Error('agents-api: "uploads.dir" must be a separate directory, not inside or containing "workspaces"')
  }
  return staging
}
