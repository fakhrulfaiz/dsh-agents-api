/**
 * Images a tool returned (for example `read_image` or a browser screenshot): their wire parts on
 * `function_call_output` items and the `FileSource` that serves their bytes.
 *
 * A tool result logs each image as a DSH `ImageBlock` (`{ type: 'image', attachment: ImageAttachmentRef }`).
 * The wire part carries a `file_id` derived only from the session id and the attachment id, so the live
 * projection and a replay of the log give the same id and no database row is needed. Serving the id checks
 * that the caller owns the session, then looks the image up among the tool results in the session's log
 * (and its live subagents' logs). Another owner's id, an id the session never produced, and a malformed id
 * all read as absent (404). The attachment id itself never leaves the API.
 */

import { createHash } from 'node:crypto'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { OwnerId } from '../auth/authenticator.ts'
import { AgentsApiRequestError } from '../errors.ts'
import type { OAIOutputImagePart } from '../types.ts'
import type { AttachmentsPort } from './attached.ts'
import type { FileSource } from './content.ts'

const PREFIX = 'timg_'
const ID_PATTERN = /^timg_([A-Za-z0-9_-]{1,128})_([0-9a-f]{32})$/u

/** Extension per raster type, for the served name. */
const EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * @param attachmentId - DSH attachment id.
 * @returns the 32-hex digest that names it inside a file id.
 */
function digestOf(attachmentId: string): string {
  return createHash('sha256').update(attachmentId).digest('hex').slice(0, 32)
}

/**
 * @param sessionId - Agents API session whose items carry the image (the parent for subagent items).
 * @param attachmentId - DSH attachment id of the image.
 * @returns the `file_id` for `GET /agents/files/{file_id}/content`.
 */
export function toolImageFileId(sessionId: string, attachmentId: string): string {
  return `${PREFIX}${sessionId}_${digestOf(attachmentId)}`
}

/**
 * @param id - candidate file id.
 * @returns the session id and attachment digest, or `undefined` when `id` is not a tool-image id.
 */
export function parseToolImageFileId(id: string): { sessionId: string; digest: string } | undefined {
  const match = ID_PATTERN.exec(id)
  return match === null ? undefined : { sessionId: match[1]!, digest: match[2]! }
}

/**
 * Image references among the blocks of one tool result. Looks at the top-level blocks and, for older logs,
 * inside nested `tool-result` blocks.
 * @param content - logged tool result content.
 * @returns one reference per image block, in order.
 */
export function toolResultImageRefs(content: unknown): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  const visit = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks as unknown[]) {
      if (block === null || typeof block !== 'object') continue
      const rec = block as { type?: unknown; attachment?: unknown; content?: unknown }
      if (rec.type === 'tool-result') {
        visit(rec.content)
        continue
      }
      if (rec.type !== 'image' || rec.attachment === null || typeof rec.attachment !== 'object') continue
      const ref = rec.attachment as Partial<ImageAttachmentRef>
      if (typeof ref.attachmentId !== 'string' || typeof ref.mediaType !== 'string') continue
      refs.push(ref as ImageAttachmentRef)
    }
  }
  visit(content)
  return refs
}

/**
 * Wire parts for the image blocks of one tool result.
 * @param content - logged tool result content.
 * @param sessionId - session the item belongs to; without it the parts carry no `file_id`.
 * @returns one part per image, in order.
 */
export function outputImageParts(content: unknown, sessionId: string | undefined): OAIOutputImagePart[] {
  return toolResultImageRefs(content).map(ref => ({
    type: 'output_image',
    ...(sessionId === undefined ? {} : { file_id: toolImageFileId(sessionId, ref.attachmentId) }),
    ...(typeof ref.name === 'string' ? { filename: ref.name } : {}),
    media_type: ref.mediaType,
    bytes: typeof ref.bytes === 'number' ? ref.bytes : 0,
    ...(typeof ref.width === 'number' ? { width: ref.width } : {}),
    ...(typeof ref.height === 'number' ? { height: ref.height } : {}),
  }))
}

/**
 * Source of tool-result images.
 * @param deps - owner check, the image references logged under a session, and the attachment service.
 * @returns the source.
 */
export function toolImageSource(deps: {
  /**
   * @returns the image references in the tool results of `sessionId` and its live subagents, or `undefined`
   *   when `owner` has no such session.
   */
  imageRefs: (owner: OwnerId, sessionId: string) => Promise<readonly ImageAttachmentRef[] | undefined>
  attachments: () => AttachmentsPort | undefined
}): FileSource {
  return {
    async open(owner, id) {
      const parsed = parseToolImageFileId(id)
      if (parsed === undefined) return undefined
      const refs = await deps.imageRefs(owner, parsed.sessionId)
      const ref = refs?.find(candidate => digestOf(candidate.attachmentId) === parsed.digest)
      if (ref === undefined) return undefined
      const attachments = deps.attachments()
      if (attachments === undefined) throw new AgentsApiRequestError('The attachment store is not available', 503, 'attachments_unavailable')
      let stored: Awaited<ReturnType<AttachmentsPort['readImage']>>
      try {
        stored = await attachments.readImage(ref)
      } catch {
        // A missing or corrupt object is absent, like a removed upload.
        return undefined
      }
      const name = ref.name ?? `image.${EXTENSIONS[stored.ref.mediaType] ?? 'bin'}`
      return { name, mediaType: stored.ref.mediaType, bytes: stored.data.byteLength, body: async function* () { yield stored.data } }
    },
  }
}
