import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMPORT_HOSTS, fetchAllowed, listFolderCandidates, resolveImportTarget } from '../src/agent-import/fetch.ts'
import { ImportError } from '../src/agent-import/parse.ts'

const hosts = DEFAULT_IMPORT_HOSTS
const deps = (impl: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => impl(String(url), init))
  return { fetch, deps: { hosts, github: { apiBase: 'https://api.github.test', codeloadBase: '', fetch } } }
}
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === 'function' ? p() : p); return 'ok' } catch (e) { return (e as ImportError).code }
}

describe('agent import links', () => {
  it('rewrites blob and gist links to raw files and reads tree links as folders', () => {
    expect(resolveImportTarget('https://github.com/o/r/blob/main/agents/x.md', hosts)).toEqual({ kind: 'file', url: 'https://raw.githubusercontent.com/o/r/main/agents/x.md' })
    expect(resolveImportTarget('https://gist.github.com/u/abc', hosts)).toEqual({ kind: 'file', url: 'https://gist.githubusercontent.com/u/abc/raw' })
    expect(resolveImportTarget('https://github.com/o/r/tree/main/agents', hosts)).toEqual({ kind: 'folder', owner: 'o', repo: 'r', ref: 'main', path: 'agents' })
  })

  it('refuses http, other hosts and credentials in the link', async () => {
    for (const url of ['http://github.com/o/r/blob/main/x.md', 'https://example.com/x.md', 'https://127.0.0.1/x.md', 'https://u:p@github.com/o/r/blob/m/x.md', 'https://github.com:8443/o/r/blob/m/x.md']) {
      expect(await code(() => resolveImportTarget(url, hosts))).toBe('import_host_not_allowed')
    }
  })

  it('follows redirects only onto allowed hosts, never automatically', async () => {
    const { fetch, deps: d } = deps(url => url.includes('first')
      ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
      : new Response('ok'))
    expect(await code(fetchAllowed(d, 'https://raw.githubusercontent.com/first'))).toBe('import_host_not_allowed')
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('caps the body at 256 KB and maps failures', async () => {
    expect(await code(fetchAllowed(deps(() => new Response('x'.repeat(256 * 1024 + 1))).deps, 'https://raw.githubusercontent.com/a'))).toBe('import_too_large')
    expect(await code(fetchAllowed(deps(() => { throw new Error('timeout') }).deps, 'https://raw.githubusercontent.com/a'))).toBe('import_fetch_failed')
    expect(await code(fetchAllowed(deps(() => new Response('', { status: 404 })).deps, 'https://raw.githubusercontent.com/a'))).toBe('import_not_found')
  })

  it('lists a folder\'s agent files through the contents API', async () => {
    const { fetch, deps: d } = deps((url) => {
      if (url.startsWith('https://api.github.test/repos/o/r/contents/agents?ref=main')) {
        return Response.json([{ type: 'file', name: 'a.md', path: 'agents/a.md' }, { type: 'file', name: 'notes.md', path: 'agents/notes.md' }, { type: 'dir', name: 'x', path: 'agents/x' }])
      }
      if (url.endsWith('/a.md')) return new Response('---\nname: alpha\ndescription: first\n---\nbody')
      return new Response('# just notes')
    })
    expect(await listFolderCandidates(d, { kind: 'folder', owner: 'o', repo: 'r', ref: 'main', path: 'agents' })).toEqual([
      { name: 'alpha', description: 'first', url: 'https://github.com/o/r/blob/main/agents/a.md' },
    ])
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
