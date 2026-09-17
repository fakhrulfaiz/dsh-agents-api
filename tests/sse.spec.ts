import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { pipeSSEStream, writeDone, writeEvent, writeSSEHeaders } from '../src/sse.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })))
})

async function serve(handler: (res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((_req, res) => {
    void handler(res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

describe('SSE helpers', () => {
  it('writes named events, string payloads, and a done frame', async () => {
    const base = await serve((res) => {
      writeSSEHeaders(res)
      writeEvent(res, 'ping', { ok: true })
      writeEvent(res, 'raw', 'hello')
      writeDone(res)
    })
    const body = await (await fetch(base)).text()
    expect(body).toContain('event: ping')
    expect(body).toContain('data: {"ok":true}')
    expect(body).toContain('data: hello')
    expect(body).toContain('data: [DONE]')
  })

  it('skips flushHeaders when the response does not expose it', () => {
    const headers: Record<string, string> = {}
    writeSSEHeaders({
      setHeader(name: string, value: string) {
        headers[name] = value
      },
    } as unknown as ServerResponse)
    expect(headers['Content-Type']).toBe('text/event-stream')
  })

  it('pipes an async iterable then closes', async () => {
    async function* stream() {
      yield { event: 'one', data: { n: 1 } }
    }
    const base = await serve(res => pipeSSEStream(res, stream()))
    const body = await (await fetch(base)).text()
    expect(body).toContain('event: one')
    expect(body).toContain('data: [DONE]')
  })
})
