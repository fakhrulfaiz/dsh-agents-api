import { describe, expect, it } from 'vitest'
import { artifactContentDisposition, artifactContentType } from '../src/artifacts.ts'

describe('artifact headers', () => {
  it('derives Content-Type from the extension', () => {
    expect(artifactContentType('a/report.PDF')).toBe('application/pdf')
    expect(artifactContentType('notes.md')).toBe('text/markdown; charset=utf-8')
    expect(artifactContentType('d.json')).toBe('application/json; charset=utf-8')
    expect(artifactContentType('pic.png')).toBe('image/png')
    expect(artifactContentType('blob.xyz')).toBe('application/octet-stream')
    expect(artifactContentType('noext')).toBe('application/octet-stream')
  })

  it('builds inline or attachment dispositions from the last segment', () => {
    expect(artifactContentDisposition('a/b.txt', false)).toBe('inline; filename="b.txt"')
    expect(artifactContentDisposition('a/b.txt', true)).toBe('attachment; filename="b.txt"')
    expect(artifactContentDisposition('a/q"é.txt', false)).toBe('inline; filename="q__.txt"')
  })
})
