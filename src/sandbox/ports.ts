/**
 * Listening TCP ports of a sandbox, from `/proc/net/tcp{,6}` (no tools needed in the image). Only ports an app
 * bound to all addresses are listed: the service reaches a port at the container's address, so a server bound to
 * 127.0.0.1 only (Chromium's DevTools port, `vite` without `--host`) cannot be previewed.
 */

/** envd's own port; never offered. */
const HIDDEN = new Set([49983])

export const LISTING_SCRIPT = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null'

const LOOPBACK = new Set(['0100007F', '00000000000000000000000001000000', '0000000000000000FFFF00000100007F'])

/** The previewable ports in the text of `/proc/net/tcp` and `/proc/net/tcp6`, ascending. */
export function parseListeningPorts(text: string): number[] {
  const out = new Set<number>()
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/)
    const local = cols[1]
    if (cols[3] !== '0A' || local === undefined) continue
    const [addr, hex] = local.split(':')
    const port = hex === undefined ? NaN : Number.parseInt(hex, 16)
    if (!Number.isInteger(port) || port < 1 || HIDDEN.has(port) || addr === undefined || LOOPBACK.has(addr.toUpperCase())) continue
    out.add(port)
  }
  return [...out].sort((a, b) => a - b)
}
