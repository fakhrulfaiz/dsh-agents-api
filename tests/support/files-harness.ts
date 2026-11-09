/**
 * Gateway over fakes with uploads enabled: temp staging and workspace directories, owner taken from the bearer
 * token, a recording fake agent, and an in-memory DSH attachment service.
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ownerId, type Authenticator } from '../../src/auth/authenticator.ts'
import { createLocalProvider } from '../../src/environment/local.ts'
import type { AttachmentsPort } from '../../src/files/attached.ts'
import { DEFAULT_ALLOWED_MEDIA_TYPES, type UploadLimits } from '../../src/files/config.ts'
import { createFilesystemFileStore, type FileStore } from '../../src/files/file-store.ts'
import { AgentsGateway } from '../../src/gateway.ts'
import { SessionRegistry } from '../../src/session-registry.ts'
import { FakeSessionQuery, testGatewayOptions } from './fake-session-query.ts'
import { MemoryStore } from './memory-store.ts'

/** A minimal PNG: signature plus filler. DSH decoding is faked, so only the magic bytes matter. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])

/** In-memory `ctx.attachments` stand-in. */
export class FakeAttachments implements AttachmentsPort {
  readonly images = new Map<string, Buffer>()
  readonly files = new Map<string, Buffer>()
  /** Make `saveImage` reject, as DSH does for an undecodable image. */
  failImages = false

  saveImage: AttachmentsPort['saveImage'] = (input) => {
    if (this.failImages) return Promise.reject(new Error('cannot decode image'))
    const data = Buffer.from(input.data)
    const id = `img-${createHash('sha256').update(data).digest('hex').slice(0, 16)}`
    this.images.set(id, data)
    const ref: ImageAttachmentRef = { attachmentId: AttachmentId(id), mediaType: input.mediaType, bytes: data.length, width: 16, height: 9, ...(input.name === undefined ? {} : { name: input.name }) }
    return Promise.resolve(ref)
  }

  readImage: AttachmentsPort['readImage'] = (ref) => {
    const data = this.images.get(ref.attachmentId)
    return data === undefined ? Promise.reject(new Error('missing image')) : Promise.resolve({ ref, data })
  }

  saveFileStream: AttachmentsPort['saveFileStream'] = async (input) => {
    const chunks: Buffer[] = []
    for await (const chunk of input.data) chunks.push(Buffer.from(chunk))
    const data = Buffer.concat(chunks)
    const id = `file-${createHash('sha256').update(data).digest('hex').slice(0, 16)}`
    this.files.set(id, data)
    const ref: FileAttachmentRef = { attachmentId: AttachmentId(id), name: input.name ?? 'file', bytes: data.length }
    return ref
  }

  readFileStream: AttachmentsPort['readFileStream'] = (ref) => {
    const data = this.files.get(ref.attachmentId)
    if (data === undefined) throw new Error('missing file')
    return (async function* () { yield data })()
  }
}

/** What a fake agent recorded. */
export interface RecordedAgent {
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
}

export interface FilesHarnessOptions {
  /** Overrides of the default limits (25 MiB / 10 files / 50 MiB / 500 MiB). */
  limits?: Partial<UploadLimits>
  /** Leave `uploads.dir` unset. */
  uploadsOff?: boolean
  /** Omit the DSH attachment service. */
  noAttachments?: boolean
  /** `inputModalities` the fake model reports; `undefined` reports no list. */
  inputModalities?: string[] | undefined
}

/** Bearer-token authenticator: the token is the owner id. */
const tokenAuth: Authenticator = {
  authenticate: (req) => {
    const token = /^Bearer (.+)$/u.exec(req.headers.authorization ?? '')?.[1]
    return Promise.resolve(token === undefined
      ? { ok: false as const, status: 401 as const, code: 'unauthenticated' as const, message: 'no token' }
      : { ok: true as const, principal: { owner: ownerId(token), roles: new Set(['agentry-user' as const]) } })
  },
}

/**
 * Start a gateway on a random port.
 * @param options - limits and feature switches.
 * @returns the gateway, fakes, URLs, and a `close` that removes the temp directories.
 */
export async function filesHarness(options: FilesHarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentry-files-'))
  const stagingDir = join(root, 'staging')
  const workspaces = join(root, 'workspaces')
  const staging: FileStore = createFilesystemFileStore(stagingDir)
  await staging.verify()
  const limits: UploadLimits = {
    maxFileBytes: 25 * 1024 * 1024,
    maxFilesPerMessage: 10,
    maxMessageBytes: 50 * 1024 * 1024,
    maxStagedBytesPerOwner: 500 * 1024 * 1024,
    allowedMediaTypes: [...DEFAULT_ALLOWED_MEDIA_TYPES],
    ...options.limits,
  }
  const attachments = new FakeAttachments()
  const agents = new Map<string, RecordedAgent>()
  const sessions = new Map<string, { id: string }>()
  const inputModalities = 'inputModalities' in options ? options.inputModalities : ['text', 'image']
  const ctx = {
    agents: {
      create: ({ sessionId }: { sessionId: string }) => {
        const agent: RecordedAgent & { model: { current: () => { provider: string; model: string }; select: () => void } } = {
          followup: vi.fn(),
          steer: vi.fn(),
          model: { current: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }), select: vi.fn() },
        }
        agents.set(sessionId, agent)
        sessions.set(sessionId, { id: sessionId })
        return Promise.resolve({ agent: { ...agent, cancel: vi.fn() }, dispose: vi.fn(() => Promise.resolve()) })
      },
      get: (id: string) => agents.get(id),
    },
    sessions: { get: (id: string) => sessions.get(id) },
    llm: {
      resolveCallConfig: vi.fn((config: unknown) => Promise.resolve(config)),
      resolveModelInfo: vi.fn(() => Promise.resolve({ model: 'deepseek-flash', ...(inputModalities === undefined ? {} : { inputModalities }) })),
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    tools: { schemas: () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  } as unknown as Context
  const store = new MemoryStore()
  const query = new FakeSessionQuery()
  const gatewayOptions = {
    ...testGatewayOptions(createLocalProvider(workspaces), query),
    workspacesRoot: workspaces,
    ...(options.uploadsOff === true ? {} : { files: { staging, limits } }),
    attachments: () => options.noAttachments === true ? undefined : attachments,
  }
  const api = new AgentsGateway(ctx, tokenAuth, '/v1', store, new SessionRegistry(), gatewayOptions)
  const server: Server = createServer((req, res) => {
    void api.handle(req, res)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  /** Upload `bytes` as `filename` for `owner`. */
  async function upload(owner: string, filename: string, bytes: Uint8Array | string, type?: string, extra?: (form: FormData) => void) {
    const form = new FormData()
    form.append('file', new Blob([typeof bytes === 'string' ? bytes : Buffer.from(bytes)], type === undefined ? {} : { type }), filename)
    extra?.(form)
    const res = await fetch(`${origin}/v1/agents/files`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: form })
    return { status: res.status, body: await res.json() as Record<string, any>, headers: res.headers }
  }

  /** JSON request as `owner`. */
  async function request(owner: string, method: string, path: string, body?: unknown) {
    const res = await fetch(`${origin}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${owner}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? undefined : JSON.parse(text) as Record<string, any>, headers: res.headers }
  }

  return {
    origin,
    root,
    stagingDir,
    workspaces,
    staging,
    store,
    api,
    ctx,
    agents,
    attachments,
    limits,
    upload,
    request,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      await rm(root, { recursive: true, force: true })
    },
  }
}
