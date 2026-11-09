import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ATTACHMENT_NOTE_PREFIX } from '../src/files/ingest.ts'
import { filesHarness, PNG } from './support/files-harness.ts'
import { logEvent } from './support/fake-session-query.ts'

type Harness = Awaited<ReturnType<typeof filesHarness>>
const open: Harness[] = []

async function start(options?: Parameters<typeof filesHarness>[0]): Promise<Harness> {
  const harness = await filesHarness(options)
  open.push(harness)
  return harness
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(harness => harness.close()))
})

const AGENT = { model: 'deepseek-flash' }

const parts = (...fileIds: Array<[type: 'input_image' | 'input_file', id: string]>) => fileIds.map(([type, id]) => ({ type, file_id: id }))
const message = (text: string | undefined, ...fileIds: Array<[type: 'input_image' | 'input_file', id: string]>) => [{
  role: 'user',
  content: [...(text === undefined ? [] : [{ type: 'input_text', text }]), ...parts(...fileIds)],
}]

async function newChat(h: Harness, owner: string, input?: unknown) {
  return h.request(owner, 'POST', '/agents/sessions', { agent: AGENT, environment: { type: 'none' }, ...(input === undefined ? {} : { input }) })
}

/** The one user message the fake agent received. */
function sent(h: Harness, sessionId: string, via: 'followup' | 'steer' = 'followup') {
  const calls = h.agents.get(sessionId)![via].mock.calls
  expect(calls).toHaveLength(1)
  return calls[0]![0] as { content: Array<Record<string, any>>; source: { kind: string } }
}

async function sendEvent(h: Harness, owner: string, sessionId: string, input: unknown) {
  return h.request(owner, 'POST', `/agents/sessions/${sessionId}/events`, { type: 'agent.session.input.message', input })
}

describe('attach on create (new chat)', () => {
  it('stores an image as an image block on a vision route, copies it to uploads/, and queues text, image, and note', async () => {
    const h = await start()
    const png = await h.upload('alice', 'shot.png', PNG, 'image/png')
    const res = await newChat(h, 'alice', message('what is this?', ['input_image', png.body['id']]))
    expect(res.status).toBe(200)
    const sessionId = res.body!['id'] as string
    const user = sent(h, sessionId)
    expect(user.source).toEqual({ kind: 'user' })
    expect(user.content.map(block => block['type'])).toEqual(['text', 'image', 'text'])
    expect(user.content[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(user.content[1]!['attachment']).toMatchObject({ mediaType: 'image/png', bytes: PNG.length, width: 16, height: 9, name: 'shot.png' })
    expect(user.content[2]!['text']).toBe(`${ATTACHMENT_NOTE_PREFIX} uploads/shot.png (image/png, 72 B)`)
    const workspace = join(h.workspaces, 'alice', sessionId)
    expect(await readFile(join(workspace, 'uploads', 'shot.png'))).toEqual(PNG)
    const row = await h.store.files.get(png.body['id'], 'alice' as never)
    expect(row).toMatchObject({ status: 'attached', sessionId, workspacePath: 'uploads/shot.png', attachment: { kind: 'image' } })
    expect(await h.staging.list()).toEqual([])
    expect(h.attachments.images.size).toBe(1)
  })

  it('stores images as files on a text-only route and always stores other files as files', async () => {
    const h = await start({ inputModalities: ['text'] })
    const png = await h.upload('alice', 'shot.png', PNG, 'image/png')
    const txt = await h.upload('alice', 'notes.txt', 'hello', 'text/plain')
    const res = await newChat(h, 'alice', message(undefined, ['input_image', png.body['id']], ['input_file', txt.body['id']]))
    expect(res.status).toBe(200)
    const user = sent(h, res.body!['id'])
    expect(user.content.map(block => block['type'])).toEqual(['file', 'file', 'text'])
    expect(user.content[0]!['attachment']).toMatchObject({ name: 'shot.png', bytes: PNG.length })
    expect(user.content[2]!['text']).toContain('uploads/shot.png (image/png, 72 B); uploads/notes.txt (text/plain, 5 B)')
    expect(h.attachments.images.size).toBe(0)
    expect(h.attachments.files.size).toBe(2)
  })

  it('treats a route without a modality list as vision-capable, and a failed lookup as text-only', async () => {
    const open1 = await start({ inputModalities: undefined })
    const a = await open1.upload('alice', 'a.png', PNG, 'image/png')
    expect(sent(open1, (await newChat(open1, 'alice', message('x', ['input_image', a.body['id']]))).body!['id']).content[1]!['type']).toBe('image')
    const broken = await start()
    ;(broken.ctx as any).llm.resolveModelInfo = () => Promise.reject(new Error('unknown route'))
    const b = await broken.upload('alice', 'a.png', PNG, 'image/png')
    expect(sent(broken, (await newChat(broken, 'alice', message('x', ['input_image', b.body['id']]))).body!['id']).content[1]!['type']).toBe('file')
  })

  it('sends an image DSH cannot decode as a file', async () => {
    const h = await start()
    h.attachments.failImages = true
    const png = await h.upload('alice', 'bad.png', PNG, 'image/png')
    const res = await newChat(h, 'alice', message('look', ['input_image', png.body['id']]))
    expect(res.status).toBe(200)
    expect(sent(h, res.body!['id']).content.map(block => block['type'])).toEqual(['text', 'file', 'text'])
  })

  it('accepts a message with files and no text', async () => {
    const h = await start()
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    const res = await newChat(h, 'alice', message(undefined, ['input_file', txt.body['id']]))
    expect(res.status).toBe(200)
    expect(sent(h, res.body!['id']).content.map(block => block['type'])).toEqual(['file', 'text'])
  })

  it('creates nothing when a file id is unknown, foreign, duplicated, or unsupported', async () => {
    const h = await start()
    const mine = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    const theirs = await h.upload('bob', 'b.txt', 'x', 'text/plain')
    const cases: Array<[unknown, number, string]> = [
      [message('x', ['input_file', 'file_missing']), 404, 'file_not_found'],
      [message('x', ['input_file', theirs.body['id']]), 404, 'file_not_found'],
      [message('x', ['input_file', mine.body['id']], ['input_file', mine.body['id']]), 400, 'duplicate_file_id'],
      [[{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }], 400, 'unsupported_content_part'],
      [[{ role: 'user', content: [{ type: 'input_file', file_data: 'AAAA' }] }], 400, 'unsupported_content_part'],
      [[{ role: 'user', content: [{ type: 'input_file' }] }], 400, 'unsupported_content_part'],
    ]
    for (const [input, status, code] of cases) {
      const res = await newChat(h, 'alice', input)
      expect([res.status, res.body?.['error']?.code], JSON.stringify(input)).toEqual([status, code])
    }
    expect((await h.request('alice', 'GET', '/agents/sessions')).body!['data']).toEqual([])
    expect(h.agents.size).toBe(0)
    expect(await h.store.files.get(mine.body['id'], 'alice' as never)).toMatchObject({ status: 'staged' })
    expect(await h.store.files.get(theirs.body['id'], 'bob' as never)).toMatchObject({ status: 'staged' })
  })

  it('enforces the per-message file count and total size', async () => {
    const h = await start({ limits: { maxFilesPerMessage: 2, maxMessageBytes: 10, maxFileBytes: 8 } })
    const ids: string[] = []
    for (const name of ['a.txt', 'b.txt', 'c.txt']) ids.push((await h.upload('alice', name, 'hello', 'text/plain')).body['id'])
    const many = await newChat(h, 'alice', message('x', ...ids.map(id => ['input_file', id] as ['input_file', string])))
    expect([many.status, many.body!['error'].code]).toEqual([400, 'too_many_files'])
    const big = await newChat(h, 'alice', message('x', ['input_file', ids[0]!], ['input_file', ids[1]!]))
    expect(big.status).toBe(200)
  })

  it('rejects a message whose files exceed maxMessageBytes with 413', async () => {
    const h = await start({ limits: { maxFileBytes: 8, maxMessageBytes: 8 } })
    const a = await h.upload('alice', 'a.txt', 'hello', 'text/plain')
    const b = await h.upload('alice', 'b.txt', 'hello', 'text/plain')
    const res = await newChat(h, 'alice', message('x', ['input_file', a.body['id']], ['input_file', b.body['id']]))
    expect([res.status, res.body!['error'].code]).toEqual([413, 'message_too_large'])
    expect(h.agents.size).toBe(0)
  })

  it('answers 501 when the server has uploads disabled', async () => {
    const h = await start({ uploadsOff: true })
    const res = await newChat(h, 'alice', message('x', ['input_file', 'file_x']))
    expect([res.status, res.body!['error'].code]).toEqual([501, 'uploads_disabled'])
  })

  it('discards the new session and unclaims the files when the workspace cannot take them', async () => {
    const h = await start()
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    h.attachments.saveFileStream = () => Promise.reject(new Error('disk full'))
    const res = await newChat(h, 'alice', message('x', ['input_file', txt.body['id']]))
    expect([res.status, res.body!['error'].code]).toEqual([500, 'attach_failed'])
    expect((await h.request('alice', 'GET', '/agents/sessions')).body!['data']).toEqual([])
    expect(await h.store.files.get(txt.body['id'], 'alice' as never)).toMatchObject({ status: 'staged', sessionId: null, attachment: null })
    expect(await h.staging.list()).toHaveLength(1)
  })

  it('answers 503 attachments_unavailable and keeps the file staged when the profile has no attachment service', async () => {
    const h = await start({ noAttachments: true })
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    const res = await newChat(h, 'alice', message('x', ['input_file', txt.body['id']]))
    expect([res.status, res.body!['error'].code]).toEqual([503, 'attachments_unavailable'])
    expect(await h.store.files.get(txt.body['id'], 'alice' as never)).toMatchObject({ status: 'staged' })
  })
})

describe('attach on send (open chat)', () => {
  async function openChat(h: Harness, owner = 'alice') {
    const res = await newChat(h, owner)
    return res.body!['id'] as string
  }

  it('queues the message with the files as a follow-up', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const txt = await h.upload('alice', 'plan.md', '# plan', 'text/markdown')
    const res = await sendEvent(h, 'alice', sessionId, message('read this', ['input_file', txt.body['id']]))
    expect(res.status).toBe(200)
    const user = sent(h, sessionId)
    expect(user.content.map(block => block['type'])).toEqual(['text', 'file', 'text'])
    expect(await readFile(join(h.workspaces, 'alice', sessionId, 'uploads', 'plan.md'), 'utf8')).toBe('# plan')
  })

  it('steers while a turn is running', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    h.api.applySessionEvent(sessionId, logEvent('turn/start', {}, 1))
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    expect((await sendEvent(h, 'alice', sessionId, message('also', ['input_file', txt.body['id']]))).status).toBe(200)
    expect(sent(h, sessionId, 'steer').content.map(block => block['type'])).toEqual(['text', 'file', 'text'])
    expect(h.agents.get(sessionId)!.followup).not.toHaveBeenCalled()
  })

  it("uses the model after a model change on the same request to decide image blocks", async () => {
    const h = await start()
    ;(h.ctx as any).llm.resolveModelInfo = (_provider: string, model: string) => Promise.resolve({ model, inputModalities: model === 'vision-model' ? ['text', 'image'] : ['text'] })
    const sessionId = await openChat(h)
    const png = await h.upload('alice', 'a.png', PNG, 'image/png')
    const res = await h.request('alice', 'POST', `/agents/sessions/${sessionId}/events`, { type: 'agent.session.input.message', model: 'vision-model', input: message('look', ['input_image', png.body['id']]) })
    expect(res.status).toBe(200)
    expect(sent(h, sessionId).content[1]!['type']).toBe('image')
  })

  it("answers 404 for another owner's file and does not change the model, queue a message, or claim anything", async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const theirs = await h.upload('bob', 'b.txt', 'x', 'text/plain')
    const res = await h.request('alice', 'POST', `/agents/sessions/${sessionId}/events`, { type: 'agent.session.input.message', model: 'other-model', input: message('x', ['input_file', theirs.body['id']]) })
    expect([res.status, res.body!['error'].code]).toEqual([404, 'file_not_found'])
    expect(h.agents.get(sessionId)!.followup).not.toHaveBeenCalled()
    expect((await h.request('alice', 'GET', `/agents/sessions/${sessionId}`)).body!['agent'].model).toBe('deepseek-flash')
    expect(await h.store.files.get(theirs.body['id'], 'bob' as never)).toMatchObject({ status: 'staged' })
  })

  it('rejects a file that is already attached, and a file sent twice in one batch', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    expect((await sendEvent(h, 'alice', sessionId, message('one', ['input_file', txt.body['id']]))).status).toBe(200)
    const again = await sendEvent(h, 'alice', sessionId, message('two', ['input_file', txt.body['id']]))
    expect([again.status, again.body!['error'].code]).toEqual([409, 'file_already_attached'])
    const fresh = await h.upload('alice', 'b.txt', 'y', 'text/plain')
    const batch = await h.request('alice', 'POST', `/agents/sessions/${sessionId}/events`, { events: [
      { type: 'agent.session.input.message', input: message('a', ['input_file', fresh.body['id']]) },
      { type: 'agent.session.input.message', input: message('b', ['input_file', fresh.body['id']]) },
    ] })
    expect([batch.status, batch.body!['error'].code]).toEqual([400, 'duplicate_file_id'])
    expect(h.agents.get(sessionId)!.followup).toHaveBeenCalledTimes(1)
  })

  it('lets exactly one of two concurrent sends claim a file', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    const results = await Promise.all([1, 2].map(n => sendEvent(h, 'alice', sessionId, message(`send ${String(n)}`, ['input_file', txt.body['id']]))))
    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    expect(h.agents.get(sessionId)!.followup).toHaveBeenCalledTimes(1)
    expect(await readdir(join(h.workspaces, 'alice', sessionId, 'uploads'))).toEqual(['a.txt'])
  })

  it('never overwrites: an existing name gets -1, and two files of one name get -1 and -2', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const uploads = join(h.workspaces, 'alice', sessionId, 'uploads')
    await mkdir(uploads, { recursive: true })
    await writeFile(join(uploads, 'a.txt'), 'agent work')
    const one = await h.upload('alice', 'a.txt', 'first', 'text/plain')
    const two = await h.upload('alice', 'a.txt', 'second', 'text/plain')
    expect((await sendEvent(h, 'alice', sessionId, message('x', ['input_file', one.body['id']], ['input_file', two.body['id']]))).status).toBe(200)
    expect(await readFile(join(uploads, 'a.txt'), 'utf8')).toBe('agent work')
    expect(await readFile(join(uploads, 'a-1.txt'), 'utf8')).toBe('first')
    expect(await readFile(join(uploads, 'a-2.txt'), 'utf8')).toBe('second')
    expect(sent(h, sessionId).content.at(-1)!['text']).toContain('uploads/a-1.txt')
  })

  it('refuses a symlinked uploads/ and writes nothing through it', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const outside = join(h.root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(h.workspaces, 'alice', sessionId, 'uploads'))
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    const res = await sendEvent(h, 'alice', sessionId, message('x', ['input_file', txt.body['id']]))
    expect([res.status, res.body!['error'].code]).toEqual([409, 'uploads_unsafe'])
    expect(await readdir(outside)).toEqual([])
    expect(h.agents.get(sessionId)!.followup).not.toHaveBeenCalled()
    expect(await h.store.files.get(txt.body['id'], 'alice' as never)).toMatchObject({ status: 'staged', workspacePath: null })
  })

  it('does not follow a symlink planted at the target name', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const uploads = join(h.workspaces, 'alice', sessionId, 'uploads')
    await mkdir(uploads, { recursive: true })
    const secret = join(h.root, 'secret.txt')
    await writeFile(secret, 'do not touch')
    await symlink(secret, join(uploads, 'a.txt'))
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    expect((await sendEvent(h, 'alice', sessionId, message('x', ['input_file', txt.body['id']]))).status).toBe(200)
    expect(await readFile(secret, 'utf8')).toBe('do not touch')
    expect(await readFile(join(uploads, 'a-1.txt'), 'utf8')).toBe('x')
  })

  it('rolls everything back when the agent refuses the message', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    h.agents.get(sessionId)!.followup.mockImplementation(() => {
      throw new Error('agent closed')
    })
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    const res = await sendEvent(h, 'alice', sessionId, message('x', ['input_file', txt.body['id']]))
    expect(res.status).toBe(500)
    expect(await h.store.files.get(txt.body['id'], 'alice' as never)).toMatchObject({ status: 'staged', sessionId: null })
    expect(await readdir(join(h.workspaces, 'alice', sessionId, 'uploads'))).toEqual([])
    expect(await h.staging.list()).toHaveLength(1)
  })

  it("answers 404 for a session of another owner before touching the file", async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const mine = await h.upload('bob', 'a.txt', 'x', 'text/plain')
    expect((await sendEvent(h, 'bob', sessionId, message('x', ['input_file', mine.body['id']]))).status).toBe(404)
    expect(await h.store.files.get(mine.body['id'], 'bob' as never)).toMatchObject({ status: 'staged' })
  })

  it('removes a session\'s file rows when the session is deleted, and keeps content readable until then', async () => {
    const h = await start()
    const sessionId = await openChat(h)
    const txt = await h.upload('alice', 'a.txt', 'x', 'text/plain')
    await sendEvent(h, 'alice', sessionId, message('x', ['input_file', txt.body['id']]))
    const content = await fetch(`${h.origin}/v1/agents/files/${txt.body['id']}/content`, { headers: { authorization: 'Bearer alice' } })
    expect(await content.text()).toBe('x')
    expect((await h.request('alice', 'DELETE', `/agents/sessions/${sessionId}`)).status).toBe(200)
    expect(await h.store.files.get(txt.body['id'], 'alice' as never)).toBeUndefined()
    const gone = await fetch(`${h.origin}/v1/agents/files/${txt.body['id']}/content`, { headers: { authorization: 'Bearer alice' } })
    expect(gone.status).toBe(404)
  })
})
