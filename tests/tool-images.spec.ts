import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { itemsFromEvent } from '../src/items.ts'
import { foldSession, type ProjectionBase } from '../src/history/projector.ts'
import { outputImageParts, parseToolImageFileId, toolImageFileId } from '../src/files/tool-images.ts'
import { filesHarness, PNG } from './support/files-harness.ts'
import { logEvent } from './support/fake-session-query.ts'

type Harness = Awaited<ReturnType<typeof filesHarness>>
const open: Harness[] = []

async function start(): Promise<Harness> {
  const harness = await filesHarness()
  open.push(harness)
  return harness
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(harness => harness.close()))
})

const REF = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 72, width: 16, height: 9, name: 'shot.png' }

/** A tool result as DSH logs it: text plus one image block. */
function imageResult(seq: number, ref: Record<string, unknown> = REF): SessionEvent {
  return logEvent('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'Read image shot.png' }, { type: 'image', attachment: ref }] },
  }, seq)
}

describe('tool-result image parts', () => {
  it('projects image blocks as output_image parts with a session-derived file_id and no attachment id', () => {
    const [item] = itemsFromEvent(imageResult(3), 'turn_1', { sessionId: 'sess_abc' })
    expect(item).toMatchObject({ type: 'function_call_output', call_id: 'c1', output: 'Read image shot.png' })
    const images = (item as { images?: unknown[] }).images
    expect(images).toEqual([{ type: 'output_image', file_id: toolImageFileId('sess_abc', 'sha256:abc'), filename: 'shot.png', media_type: 'image/png', bytes: 72, width: 16, height: 9 }])
    expect(JSON.stringify(item)).not.toContain('sha256:abc')
  })

  it('finds images nested in legacy tool-result blocks and leaves text-only results without images', () => {
    expect(outputImageParts([{ type: 'tool-result', content: [{ type: 'image', attachment: REF }] }], 's')).toHaveLength(1)
    const [plain] = itemsFromEvent(logEvent('tool/result', { message: { callId: 'c', content: [{ type: 'text', text: 'ok' }] } }, 1), 't', { sessionId: 's' })
    expect(plain).not.toHaveProperty('images')
  })

  it('gives the same file_id live and on replay', () => {
    const base = { sessionId: 'sess_1', createdAt: 0, agent: { id: 'a', tools: [] }, environment: { type: 'none' }, metadata: {}, vaultIds: [] } as unknown as ProjectionBase
    const events = [logEvent('turn/start', { turn: 1 }, 1), imageResult(2)]
    const a = foldSession(base, events).items.find(item => item.type === 'function_call_output')
    const b = foldSession(base, events).items.find(item => item.type === 'function_call_output')
    expect(a).toEqual(b)
    expect((a as { images: Array<{ file_id: string }> }).images[0]!.file_id).toBe(toolImageFileId('sess_1', 'sha256:abc'))
  })

  it('parses only well-formed ids', () => {
    const id = toolImageFileId('sess_0123abcd', 'x')
    expect(parseToolImageFileId(id)).toEqual({ sessionId: 'sess_0123abcd', digest: id.slice(-32) })
    expect(parseToolImageFileId('file_123')).toBeUndefined()
    expect(parseToolImageFileId('timg_../etc_0123')).toBeUndefined()
  })
})

describe('GET /agents/files/{id}/content for tool-result images', () => {
  async function chatWithImage(h: Harness) {
    const res = await h.request('alice', 'POST', '/agents/sessions', { agent: { model: 'deepseek-flash' }, environment: { type: 'none' } })
    const sessionId = res.body!['id'] as string
    const ref = await h.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'shot.png' } as never)
    h.query.append(sessionId, logEvent('turn/start', { turn: 1 }, 1))
    h.query.append(sessionId, logEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read_image', arguments: '{"path":"shot.png"}' }, 2))
    h.query.append(sessionId, imageResult(3, ref as unknown as Record<string, unknown>))
    const items = await h.request('alice', 'GET', `/agents/sessions/${sessionId}/items`)
    const output = (items.body!['data'] as Array<Record<string, any>>).find(item => item['type'] === 'function_call_output')!
    return { sessionId, fileId: output['images'][0]['file_id'] as string, output }
  }

  async function get(h: Harness, owner: string, id: string) {
    const res = await fetch(`${h.origin}/v1/agents/files/${id}/content`, { headers: { authorization: `Bearer ${owner}` } })
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }
  }

  it('serves the image inline with nosniff to the owner', async () => {
    const h = await start()
    const { fileId, output } = await chatWithImage(h)
    expect(output['images'][0]).toMatchObject({ type: 'output_image', media_type: 'image/png', bytes: PNG.length, width: 16, height: 9 })
    expect(JSON.stringify(output)).not.toContain('img-')
    const res = await get(h, 'alice', fileId)
    expect(res.status).toBe(200)
    expect(res.bytes).toEqual(PNG)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toBe('inline')
  })

  it('answers 404 to another owner, for an image the session never produced, and when the object is gone', async () => {
    const h = await start()
    const { sessionId, fileId } = await chatWithImage(h)
    expect((await get(h, 'mallory', fileId)).status).toBe(404)
    expect((await get(h, 'alice', toolImageFileId(sessionId, 'img-not-in-log'))).status).toBe(404)
    h.attachments.images.clear()
    expect((await get(h, 'alice', fileId)).status).toBe(404)
  })

  it('keeps serving the same id after a restart (replayed log)', async () => {
    const h = await start()
    const { sessionId, fileId } = await chatWithImage(h)
    h.query.crash(sessionId)
    const items = await h.request('alice', 'GET', `/agents/sessions/${sessionId}/items`)
    const output = (items.body!['data'] as Array<Record<string, any>>).find(item => item['type'] === 'function_call_output')!
    expect(output['images'][0]['file_id']).toBe(fileId)
    expect((await get(h, 'alice', fileId)).status).toBe(200)
  })
})
