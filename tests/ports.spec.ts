import { describe, expect, it } from 'vitest'
import { parseListeningPorts } from '../src/sandbox/ports.ts'

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'

describe('listening ports', () => {
  it('lists LISTEN sockets bound to all addresses, hides loopback-only, envd and other states', () => {
    const text = HEAD
      + '   0: 00000000:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1 1 0\n' // 8765 any
      + '   1: 0100007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 2 1 0\n' // 9000 loopback
      + '   2: 00000000:C33F 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0 0 3 1 0\n' // 49983 envd
      + '   3: 0A00020F:1F90 0A000001:D000 01 00000000:00000000 00:00000000 00000000  1000 0 4 1 0\n' // established
      + HEAD
      + '   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 5 1 0\n' // 8080 v6 any
      + '   1: 00000000000000000000000001000000:2329 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 6 1 0\n' // 9001 v6 loopback
    expect(parseListeningPorts(text)).toEqual([8080, 8765])
  })
})
