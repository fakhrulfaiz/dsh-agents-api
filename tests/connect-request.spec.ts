/** Connect links in tool outputs become `connect_request` on the output item. */

import { describe, expect, it } from 'vitest'
import { connectRequestFrom } from '../src/connect-request.ts'

const link = 'https://connect.composio.dev/link/lk_abc123'

describe('connectRequestFrom', () => {
  it('reads a nested JSON redirect with its toolkit', () => {
    const output = JSON.stringify({ data: { results: { gmail: { toolkit: 'gmail', status: 'initiated', redirect_url: link } } } })
    expect(connectRequestFrom(output)).toEqual({ toolkit: 'gmail', url: link, status: 'initiated' })
  })

  it('takes the toolkit from a toolkit_slug sibling and defaults the status', () => {
    expect(connectRequestFrom(JSON.stringify([{ toolkit_slug: 'github', connect_url: link }]))).toEqual({ toolkit: 'github', url: link, status: 'unknown' })
  })

  it('finds a link in plain text, with no toolkit', () => {
    expect(connectRequestFrom(`Open ${link} to connect.`)).toEqual({ toolkit: null, url: link, status: 'unknown' })
  })

  it('ignores outputs without a connect link, other hosts, and malformed JSON', () => {
    expect(connectRequestFrom('All set.')).toBeUndefined()
    expect(connectRequestFrom(JSON.stringify({ redirect_url: 'https://evil.example/link/x' }))).toBeUndefined()
    expect(connectRequestFrom('{"redirect_url": "http://connect.composio.dev/link/x"')).toBeUndefined()
    expect(connectRequestFrom('{not json')).toBeUndefined()
  })
})
