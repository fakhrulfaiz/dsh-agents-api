/**
 * Server-Sent Event framing for the Agents API output stream.
 */

import type { ServerResponse } from 'node:http'

/**
 * Write SSE response headers. Does not end the response.
 * @param res - outgoing response.
 */
export function writeSSEHeaders(res: Pick<ServerResponse, 'setHeader'> & { flushHeaders?: () => void }): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
}

/**
 * Write one named SSE event.
 * @param res - outgoing response.
 * @param event - event type name.
 * @param data - JSON object or pre-serialized payload.
 */
export function writeEvent(res: ServerResponse, event: string, data: object | string): void {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  res.write(`event: ${event}\ndata: ${payload}\n\n`)
}

/**
 * Write the terminal `[DONE]` frame and close the stream.
 * @param res - outgoing response.
 */
export function writeDone(res: ServerResponse): void {
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * Copy an async event iterable onto a response, then close it.
 * @param res - outgoing response.
 * @param stream - events to write.
 */
export async function pipeSSEStream(
  res: ServerResponse,
  stream: AsyncIterable<{ event: string; data: object | string }>,
): Promise<void> {
  writeSSEHeaders(res)
  for await (const chunk of stream) {
    writeEvent(res, chunk.event, chunk.data)
  }
  writeDone(res)
}
