/**
 * A drop-in `ssh` service for DeepSeek Harness's remote providers
 * (`dsh-fs-ssh`, `dsh-subprocess-ssh`, `dsh-sandbox-ssh`, and
 * `dsh-ptc-runtime-node` through `ptcLaunch`) whose transport is an Agentry
 * Sandbox's envd instead of OpenSSH. The DSH helper (`@deepseek-ai/dsh-ssh/helper`,
 * installed with Node at /opt/agentry/dsh by the sandbox service) runs inside
 * the sandbox as an envd process: administrative RPC uses its stdin/stdout,
 * and each program stream is a small envd process piping stdio to the
 * helper's Unix socket, authenticated end to end with the helper's TLS-PSK
 * stream key. Same public contract as DSH's `SshConnection`: one session, no
 * reconnect or replay; loss invalidates the connection.
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '@deepseek-ai/dsh-ssh/protocol'
import { helloSchema, type SshStreamEndpoint } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'
import { createSandboxApi, type EnvdClient } from '@agentry/sandbox/client'
import { EnvdProcessStream } from './envd-stream.ts'

export const DSH_RUNTIME_MANIFEST = '/opt/agentry/dsh/manifest.json'

export interface EnvdSshConfig {
  /** Agentry Sandbox base URL and service key (server-side only). */
  url: string
  key: string
  /** Owner the sandbox belongs to. */
  owner: string
  sandboxId: string
  /** Absolute workspace path inside the sandbox (identical to the host placeholder). */
  workspace: string
  /** Unix user that runs the helper and every program. */
  user?: string
  requestTimeoutMs?: number
  leaseMs?: number
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
  private readonly lifetime = new AbortController()
  private readonly ready: Promise<Hello>
  private readonly sockets = new Set<{ destroy(error?: Error): void }>()
  private manifest: Manifest | undefined
  private helper: EnvdProcessStream | undefined
  private rpc: SshRpcPeer | undefined
  private remote: Hello | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private failure: Error | undefined
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(ctx: Context, config: EnvdSshConfig) {
    super(ctx, 'ssh')
    this.config = {
      user: 'agent', requestTimeoutMs: 30_000, leaseMs: 30_000, maxFrameBytes: 64 * 1024 * 1024, maxPending: 128,
      ...config,
    }
    if (!this.config.workspace.startsWith('/')) throw new Error('sandbox workspace must be absolute')
    this.envd = createSandboxApi({ url: config.url, key: config.key, owner: config.owner }).envd(config.sandboxId)
    this.ready = this.start()
    void this.ready.catch((error: unknown) => { this.fail(error as Error) })
    ctx.effect(() => () => this.dispose())
  }

  async [Service.init](): Promise<void> { await this.ready }

  /** The PTC worker launch inside the sandbox (DSH's Node bootstrap, verified by digest at hello). */
  get ptcLaunch(): { kind: 'node-script'; executable: string; bootstrapPath: string } {
    if (this.remote === undefined || this.manifest === undefined) throw new Error('sandbox helper is not ready')
    return { kind: 'node-script', executable: this.remote.executable, bootstrapPath: this.manifest.bootstrapPath }
  }

  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    this.assertOpen()
    await this.ready
    this.assertOpen()
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return (this.rpc as SshRpcPeer).request(method, params, result, bounded)
  }

  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
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

  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('sandbox connection is closing'))
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs)).catch(() => {})
    } finally {
      this.rpc?.close()
      for (const s of [...this.sockets].reverse()) s.destroy()
      if (this.helper) {
        this.helper.end()
        const exited = await Promise.race([this.helper.exited, new Promise((r) => setTimeout(r, 3000, 'timeout'))])
        if (exited === 'timeout') await this.helper.kill(true)
        this.helper.destroy()
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('sandbox connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(error)
    for (const s of [...this.sockets].reverse()) s.destroy(error)
    this.helper?.destroy(error)
  }

  private async start(): Promise<Hello> {
    let raw: Uint8Array
    try {
      raw = await this.envd.readFile(DSH_RUNTIME_MANIFEST, this.config.user)
    } catch (e) {
      const message = (e as Error).message
      if (/ failed: 404\b/.test(message)) throw new Error('this sandbox has no DeepSeek Harness runtime at /opt/agentry/dsh (Agentry Sandbox injects it unless AGENTRY_SANDBOX_DSH_RUNTIME_IMAGE is none)')
      if (/ failed: \d{3}\b/.test(message)) throw new Error(`Agentry Sandbox refused sandbox ${this.config.sandboxId}: ${message}`)
      throw new Error(`Agentry Sandbox is not reachable for sandbox ${this.config.sandboxId}: ${message}`)
    }
    const manifest = manifestSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')))
    this.manifest = manifest
    if (this.closed) throw new Error('sandbox connection closed before startup')
    const helper = new EnvdProcessStream(this.envd, {
      cmd: manifest.node, args: ['--disable-sigusr1', manifest.helper], cwd: this.config.workspace, user: this.config.user,
    }, this.lifetime.signal)
    this.helper = helper
    helper.on('error', (error) => { this.fail(error) })
    helper.once('end', () => { this.fail(new Error(`sandbox helper disconnected; remote outcomes and cleanup are unknown${helper.stderrText ? ` (${helper.stderrText.trim().slice(0, 300)})` : ''}`)) })
    const rpc = new SshRpcPeer(helper, helper, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { this.fail(error as Error) })
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
        .catch((error: unknown) => { this.fail(error as Error) })
        .finally(() => { pending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }
}

export default EnvdSshConnection
