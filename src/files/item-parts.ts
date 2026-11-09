/**
 * Resolve the `file_id` of file parts on user message items.
 */

import type { OwnerId } from '../auth/authenticator.ts'
import type { OAIInputFilePart, OAISessionItem } from '../types.ts'
import type { FileRow, Store } from '../store/store.ts'

/**
 * Fill `file_id` and the stored `media_type` of file parts from the session's attached rows, and remove the
 * internal `attachment_id`. Parts whose attachment has no row (not uploaded through this API) keep name and size and get no `file_id`.
 * Items without file parts are returned as they are; the lookup runs once, and only when some item has one.
 * @param store - record store.
 * @param owner - owner of the session; rows of other owners never match.
 * @param sessionId - session the items belong to.
 * @param items - projected items.
 * @returns items safe to put on the wire.
 */
export async function withFileIds<T extends OAISessionItem>(store: Store, owner: OwnerId, sessionId: string, items: readonly T[]): Promise<T[]> {
  const needs = (item: OAISessionItem): boolean => item.type === 'message' && item.content.some(part => 'attachment_id' in part)
  if (!items.some(needs)) return [...items]
  const rows = await store.files.listForSession(owner, sessionId)
  const byAttachment = new Map<string, FileRow>()
  for (const row of rows) {
    const id = row.attachment?.ref.attachmentId
    if (id !== undefined && !byAttachment.has(id)) byAttachment.set(id, row)
  }
  return items.map((item) => {
    if (!needs(item) || item.type !== 'message') return item
    return {
      ...item,
      content: item.content.map((part) => {
        if (!('attachment_id' in part)) return part
        const { attachment_id: attachmentId, ...rest } = part as OAIInputFilePart
        const row = attachmentId === undefined ? undefined : byAttachment.get(attachmentId)
        return row === undefined ? rest : { ...rest, file_id: row.id, media_type: row.mediaType }
      }),
    }
  })
}
