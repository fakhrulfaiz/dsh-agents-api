/**
 * A drop-in `ssh` service for DeepSeek Harness's remote providers
 * (`dsh-fs-ssh`, `dsh-subprocess-ssh`, `dsh-sandbox-ssh`, and
 * `dsh-ptc-runtime-node` through `ptcLaunch`) whose transport is an Agentry
 * Sandbox's envd instead of OpenSSH. The DSH helper (`@deepseek-ai/dsh-ssh/helper`,
 * installed with Node at /opt/agentry/dsh by the sandbox service) runs inside
 * the sandbox as an envd process: administrative RPC uses its stdin/stdout,
 * and each program stream is a small envd process piping stdio to the
 * helper's Unix socket, authenticated end to end with the helper's TLS-PSK
 * stream key. Like DSH's `SshConnection`, nothing in flight is ever replayed and
 * loss fails every pending operation; unlike it, the next call after a loss starts a
 * new helper (a stopped sandbox is started again by the service), because a
 * sandbox can be stopped and started under a long-lived preset.
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '@deepseek-ai/dsh-ssh/protocol'
import { helloSchema, type SshStreamEndpoint } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'
import { createSandboxApi, SandboxApiError, type EnvdClient, type SandboxApi } from '@agentry/sandbox/client'
import { EnvdProcessStream } from './envd-stream.ts'

export const DSH_RUNTIME_MANIFEST = '/opt/agentry/dsh/manifest.json'

export interface EnvdSshConfig {
  /** Agentry Sandbox base URL and service key (server-side only); default: the API's configured credentials. */
  url?: string
  key?: string
  /** Owner the sandbox belongs to. */
  owner: string
  sandboxId: string
  /** Absolute workspace path inside the sandbox (identical to the host placeholder). */
  workspace: string
  /** Unix user that runs the helper and every program. */
  user?: string
  requestTimeoutMs?: number
  leaseMs?: number
  /** Close the helper after this long without calls or open program streams (default 10 minutes), so the sandbox can idle-stop; the next call starts a new one. */
  idleMs?: number
  maxFrameBytes?: number
  maxPending?: number
}

const manifestSchema = z.object({
  version: z.string(),
  node: z.string().startsWith('/'),
  helper: z.string().startsWith('/'),
  helperHash: z.string().regex(/^[0-9a-f]{64}$/),
  bootstrapPath: z.string().startsWith('/'),
  bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/),
})
type Manifest = z.infer<typeof manifestSchema>
type Hello = z.infer<typeof helloSchema>

/** Pipes stdio to one Unix socket (half-close aware); argv[1] is the socket path. */
const STREAM_BRIDGE = [
  "const s=require('net').connect({path:process.argv[1],allowHalfOpen:true});",
  "s.on('error',e=>{process.stderr.write(String(e&&e.message||e));process.exit(1)});",
  "process.stdin.pipe(s);s.pipe(process.stdout);",
  "s.on('close',()=>process.exit(0));",
].join('')

/** TLS-PSK settings of DSH's forwarded streams (dsh-ssh stream-security): certificate-free PSK, AEAD only. */
const STREAM_TLS = { ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' } as const

function authenticate(socket: EnvdProcessStream, capability: string, timeoutMs: number, signal: AbortSignal): Promise<TLSSocket> {
  signal.throwIfAborted()
  const stream = tlsConnect({
    ...STREAM_TLS,
    socket: socket as unknown as Socket,
    rejectUnauthorized: true,
    pskCallback: () => ({ psk: Buffer.from(capability, 'hex'), identity: 'dsh-stream' }),
    checkServerIdentity: () => undefined,
  })
  const abort = (): void => { stream.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))) }
  signal.addEventListener('abort', abort, { once: true })
  stream.once('close', () => { signal.removeEventListener('abort', abort); socket.destroy() })
  return new Promise<TLSSocket>((resolve, reject) => {
    const timer = setTimeout(() => { done(new Error('sandbox stream authentication timed out')) }, timeoutMs)
    const done = (error?: Error): void => {
      clearTimeout(timer)
      stream.off('secureConnect', ok)
      stream.off('error', done)
      stream.off('close', closed)
      if (error) { stream.destroy(); reject(error) } else { stream.disableRenegotiation(); stream.pause(); resolve(stream) }
    }
    const ok = (): void => { done() }
    const closed = (): void => { done(new Error(`sandbox stream closed during authentication${socket.stderrText ? `: ${socket.stderrText.trim()}` : ''}`)) }
    stream.once('secureConnect', ok)
    stream.once('error', done)
    stream.once('close', closed)
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context { ssh: EnvdSshConnection }
}

export class EnvdSshConnection extends Service {
  private readonly config: Required<EnvdSshConfig>
  private readonly envd: EnvdClient
  private readonly api: SandboxApi
  private lifetime = new AbortController()
  private ready: Promise<Hello>
  private readonly sockets = new Set<{ destroy(error?: Error): void }>()
  private manifest: Manifest | undefined
  private helper: EnvdProcessStream | undefined
  private rpc: SshRpcPeer | undefined
  private remote: Hello | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private failure: Error | undefined
  private closed = false
  private lastUsed = Date.now()
  private inFlight = 0
  private idleTimer: NodeJS.Timeout | undefined
  private disposal: Promise<void> | undefined

  constructor(ctx: Context, config: EnvdSshConfig) {
    super(ctx, 'ssh')
    const credentials = (globalThis as Record<symbol, unknown>)[Symbol.for('agentry.sandbox.credentials')] as { url: string; key: string } | undefined
    const url = config.url ?? credentials?.url
    const key = config.key ?? credentials?.key
    if (!url || !key) throw new Error('Agentry Sandbox is not configured (sandbox.url / sandbox.key)')
    this.config = {
      user: 'agent', requestTimeoutMs: 30_000, leaseMs: 30_000, idleMs: 10 * 60_000, maxFrameBytes: 64 * 1024 * 1024, maxPending: 128,
      ...config, url, key,
    }
    if (!this.config.workspace.startsWith('/')) throw new Error('sandbox workspace must be absolute')
    this.api = createSandboxApi({ url, key, owner: config.owner })
    this.envd = this.api.envd(config.sandboxId)
    this.ready = this.start()
    void this.ready.catch((error: unknown) => { this.fail(error as Error) })
    ctx.effect(() => () => this.dispose())
  }

  async [Service.init](): Promise<void> { await this.ready }

  /** The current helper, starting a new one when the previous transport was lost. */
  private async current(): Promise<Hello> {
    if (this.closed) throw new Error('sandbox connection is closed')
    if (this.failure !== undefined) {
      this.failure = undefined
      this.lifetime = new AbortController()
      this.ready = this.start()
      void this.ready.catch((error: unknown) => { this.fail(error as Error) })
    }
    return this.ready
  }

  /** The PTC worker launch inside the sandbox (DSH's Node bootstrap, verified by digest at hello). */
  get ptcLaunch(): { kind: 'node-script'; executable: string; bootstrapPath: string } {
    if (this.remote === undefined || this.manifest === undefined) throw new Error('sandbox helper is not ready')
    return { kind: 'node-script', executable: this.remote.executable, bootstrapPath: this.manifest.bootstrapPath }
  }

  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    this.inFlight += 1
    this.lastUsed = Date.now()
    try {
      await this.current()
      this.assertOpen()
      const bounded = wait ? signal : signal === undefined
        ? AbortSignal.timeout(this.config.requestTimeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
      return await (this.rpc as SshRpcPeer).request(method, params, result, bounded)
    } finally {
      this.inFlight -= 1
      this.lastUsed = Date.now()
    }
  }

  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    this.lastUsed = Date.now()
    const hello = await this.current()
    this.assertOpen()
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    if (!endpoint.path.startsWith(`${hello.root}/`) || /[\r\n\0]/u.test(endpoint.path)) throw new Error('sandbox helper returned an invalid stream path')
    const bridge = new EnvdProcessStream(this.envd, { cmd: (this.manifest as Manifest).node, args: ['-e', STREAM_BRIDGE, endpoint.path], user: this.config.user }, combined)
    this.sockets.add(bridge)
    bridge.once('close', () => { this.sockets.delete(bridge) })
    bridge.on('error', () => {})
    try {
      await bridge.ready()
      const secured = await authenticate(bridge, endpoint.capability, this.config.requestTimeoutMs, combined)
      this.sockets.add(secured)
      secured.on('error', () => { secured.destroy() })
      secured.once('close', () => { this.sockets.delete(secured) })
      return secured as unknown as Socket
    } catch (error) {
      bridge.destroy()
      throw error
    }
  }

  /** Close an idle helper; the connection reconnects on its next call. */
  private checkIdle(): void {
    const helper = this.helper
    if (helper === undefined || this.failure !== undefined || this.closed) return
    if (this.inFlight > 0 || this.sockets.size > 0 || Date.now() - this.lastUsed < this.config.idleMs) return
    const rpc = this.rpc
    this.fail(new Error('sandbox helper closed after being idle'), true)
    void (async () => {
      await rpc?.request('close', {}, z.null(), AbortSignal.timeout(5000)).catch(() => {})
      await this.retire(helper)
    })()
  }

  /** Let a helper exit by itself (stdin closed, then SIGTERM, then SIGKILL), then drop its stream. */
  private async retire(helper: EnvdProcessStream): Promise<void> {
    const wait = (ms: number) => Promise.race([helper.exited.then(() => true), new Promise<boolean>((r) => setTimeout(r, ms, false))])
    helper.end()
    if (!await wait(3000)) {
      await helper.kill(false)
      if (!await wait(2000)) await helper.kill(true)
    }
    helper.destroy()
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    const helper = this.helper
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs)).catch(() => {})
    } finally {
      this.lifetime.abort(new Error('sandbox connection is closing'))
      this.rpc?.close()
      for (const s of [...this.sockets].reverse()) s.destroy()
      if (helper && !helper.destroyed) await this.retire(helper)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('sandbox connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private fail(error: Error, idle = false): void {
    if (this.failure !== undefined) return
    if (!idle && process.env['AGENTRY_DEBUG_ERRORS'] === '1') process.stderr.write(`[agentry-sandbox-runtime] ${this.config.sandboxId}: ${error.message}\n`)
    this.failure = error
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (idle) return
    this.lifetime.abort(error)
    this.rpc?.close(error)
    for (const s of [...this.sockets].reverse()) s.destroy(error)
    const helper = this.helper
    if (helper && !helper.destroyed) void this.retire(helper)
  }

  private async start(): Promise<Hello> {
    let raw: Uint8Array
    try {
      raw = await this.envd.readFile(DSH_RUNTIME_MANIFEST, this.config.user)
    } catch (e) {
      const message = (e as Error).message
      if (/ failed: 404\b/.test(message)) {
        // The relay also answers 404 for a sandbox that is gone (or not this owner's): tell the two apart.
        const exists = await this.api.get(this.config.sandboxId).then(() => true, (e: unknown) => !(e instanceof SandboxApiError && e.status === 404))
        if (!exists) throw new Error(`sandbox ${this.config.sandboxId} no longer exists (it was deleted); start a new chat on another environment`)
        throw new Error('this sandbox has no DeepSeek Harness runtime at /opt/agentry/dsh (Agentry Sandbox injects it unless AGENTRY_SANDBOX_DSH_RUNTIME_IMAGE is none)')
      }
      if (/ failed: \d{3}\b/.test(message)) throw new Error(`Agentry Sandbox refused sandbox ${this.config.sandboxId}: ${message}`)
      throw new Error(`Agentry Sandbox is not reachable for sandbox ${this.config.sandboxId}: ${message}`)
    }
    const manifest = manifestSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')))
    this.manifest = manifest
    // Refresh what the API copies into the sandbox (skills) on every new helper: after a stop, reset or idle close too.
    const prepare = (globalThis as Record<symbol, unknown>)[Symbol.for('agentry.sandbox.prepare')] as ((owner: string, sandboxId: string) => Promise<void>) | undefined
    if (prepare) {
      await prepare(this.config.owner, this.config.sandboxId).catch((error: unknown) => {
        if (process.env['AGENTRY_DEBUG_ERRORS'] === '1') process.stderr.write(`[agentry-sandbox-runtime] ${this.config.sandboxId}: prepare failed: ${(error as Error).message}\n`)
      })
    }
    if (this.closed) throw new Error('sandbox connection closed before startup')
    // The helper's own stream is not tied to the connection lifetime: closing lets it exit and clean up (retire).
    const helper = new EnvdProcessStream(this.envd, {
      cmd: manifest.node, args: ['--disable-sigusr1', manifest.helper], cwd: this.config.workspace, user: this.config.user,
    })
    this.helper = helper
    // Events of an earlier helper must not fail a newer connection.
    const failHere = (error: Error): void => { if (this.helper === helper) this.fail(error) }
    helper.on('error', failHere)
    helper.once('end', () => { failHere(new Error(`sandbox helper disconnected; remote outcomes and cleanup are unknown${helper.stderrText ? ` (${helper.stderrText.trim().slice(0, 300)})` : ''}`)) })
    const rpc = new SshRpcPeer(helper, helper, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { failHere(error as Error) })
    await helper.ready()
    const hello = await rpc.request('hello', {
      protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs, bootstrapPath: manifest.bootstrapPath,
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    if (hello.hash !== manifest.helperHash) throw new Error('sandbox helper digest differs from its manifest')
    if (hello.kind !== 'node-script') throw new Error('sandbox helper runtime is not a node-script helper')
    if (hello.bootstrapHash !== manifest.bootstrapHash) throw new Error('sandbox PTC bootstrap digest differs from its manifest')
    this.remote = hello
    let pending: Promise<unknown> | undefined
    this.heartbeat = setInterval(() => {
      pending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((error: unknown) => { failHere(error as Error) })
        .finally(() => { pending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    this.lastUsed = Date.now()
    if (this.idleTimer === undefined) {
      this.idleTimer = setInterval(() => { this.checkIdle() }, Math.max(500, Math.min(60_000, Math.floor(this.config.idleMs / 3))))
      this.idleTimer.unref()
    }
    return hello
  }
}

export default EnvdSshConnection
