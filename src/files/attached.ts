/**
 * Reads of files that were attached to a message, from the DSH attachment store.
 */

import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AgentsApiRequestError } from '../errors.ts'
import type { FileRow } from '../store/store.ts'
import type { ServedFile } from './content.ts'

/** The attachment-store calls Agentry uses. */
export type AttachmentsPort = Pick<AttachmentStore, 'saveImage' | 'readImage' | 'saveFileStream' | 'readFileStream'>

/**
 * @param row - an `attached` file row.
 * @returns the DSH reference it recorded.
 * @throws AgentsApiRequestError 404 `resource_not_found` when the row carries no reference yet (a send is still in progress).
 */
function referenceOf(row: FileRow): NonNullable<FileRow['attachment']> {
  if (row.attachment === null) throw new AgentsApiRequestError(`File "${row.id}" is not available yet`, 404, 'resource_not_found')
  return row.attachment
}

/**
 * Open an attached file from the DSH attachment store. Images are served in their normalized form.
 * @param row - an `attached` row.
 * @param attachments - the attachment service, or `undefined` when the profile has none.
 * @returns the file to serve.
 * @throws AgentsApiRequestError 503 `attachments_unavailable` when there is no attachment service; 404 when the row has no reference.
 */
export async function openAttached(row: FileRow, attachments: AttachmentsPort | undefined): Promise<ServedFile> {
  const attachment = referenceOf(row)
  if (attachments === undefined) throw new AgentsApiRequestError('The attachment store is not available', 503, 'attachments_unavailable')
  if (attachment.kind === 'image') {
    const stored = await attachments.readImage(attachment.ref)
    return { name: row.name, mediaType: stored.ref.mediaType, bytes: stored.data.byteLength, body: async function* () { yield stored.data } }
  }
  const { ref } = attachment
  return { name: row.name, mediaType: row.mediaType, bytes: ref.bytes, body: () => attachments.readFileStream(ref) }
}
