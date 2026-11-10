import { describe, expect, it } from 'vitest'
import { absoluteFilePath, parseFileListQuery, parseFileWrite, relativeFilePath, selectFilePage } from '../src/environment/file-compat.ts'

const query = (qs = '') => parseFileListQuery(new URL(`http://x/files${qs}`))

describe('paths', () => {
  it('moves between workspace-relative and absolute paths', () => {
    expect(absoluteFilePath('a/b.txt')).toBe('/workspace/a/b.txt')
    expect(relativeFilePath('/workspace/a/b.txt')).toBe('a/b.txt')
    expect(relativeFilePath('a/b.txt')).toBe('a/b.txt')
    expect(relativeFilePath('/workspace')).toBe('')
  })
})

describe('parseFileListQuery', () => {
  it('defaults to 20 items, descending, and validates', () => {
    expect(query()).toEqual({ limit: 20, order: 'desc' })
    expect(query('?limit=5&order=asc&path=/workspace/a')).toEqual({ limit: 5, order: 'asc', path: '/workspace/a' })
    expect(query('?limit=0')).toEqual({ error: expect.stringContaining('limit') })
    expect(query('?limit=101')).toEqual({ error: expect.stringContaining('limit') })
    expect(query('?order=sideways')).toEqual({ error: expect.stringContaining('order') })
    expect(query('?page=!!!')).toEqual({ error: expect.stringContaining('page') })
  })
})

describe('selectFilePage', () => {
  const files = ['b.txt', 'a/z.txt', 'a/B.txt', 'a.txt', 'c/d/e.txt']

  it('orders by case-sensitive path components, a parent before its children', () => {
    const asc = selectFilePage(files, { limit: 100, order: 'asc' })
    expect(asc.items).toEqual(['a/B.txt', 'a/z.txt', 'a.txt', 'b.txt', 'c/d/e.txt'])
    expect(selectFilePage(files, { limit: 100, order: 'desc' }).items).toEqual([...asc.items].reverse())
  })

  it('restricts to a directory', () => {
    expect(selectFilePage(files, { limit: 100, order: 'asc', path: '/workspace/a' }).items).toEqual(['a/B.txt', 'a/z.txt'])
    expect(selectFilePage(files, { limit: 100, order: 'asc', path: '/workspace' }).items).toHaveLength(5)
  })

  it('pages with an opaque token that continues exactly where the page ended', () => {
    const first = selectFilePage(files, { limit: 2, order: 'asc' })
    expect(first.has_more).toBe(true)
    expect(first.items).toEqual(['a/B.txt', 'a/z.txt'])
    const second = selectFilePage(files, { limit: 2, order: 'asc', ...(first.next === undefined ? {} : { page: first.next }) })
    expect(second.items).toEqual(['a.txt', 'b.txt'])
    const third = selectFilePage(files, { limit: 2, order: 'asc', ...(second.next === undefined ? {} : { page: second.next }) })
    expect(third).toEqual({ items: ['c/d/e.txt'], has_more: false })
  })
})

describe('parseFileWrite', () => {
  it('accepts the SDK inline and file_id bodies and the earlier content forms', () => {
    expect(parseFileWrite({ type: 'inline', path: '/workspace/a/b.txt', data: Buffer.from('hi').toString('base64') })).toEqual({ kind: 'bytes', path: 'a/b.txt', bytes: Buffer.from('hi') })
    expect(parseFileWrite({ type: 'file_id', path: '/workspace/x', file_id: 'file_1' })).toEqual({ kind: 'file_id', path: 'x', fileId: 'file_1' })
    expect(parseFileWrite({ path: 'a.txt', content: 'text' })).toEqual({ kind: 'bytes', path: 'a.txt', bytes: Buffer.from('text') })
    expect(parseFileWrite({ path: 'a.txt', content_base64: Buffer.from('b').toString('base64') })).toEqual({ kind: 'bytes', path: 'a.txt', bytes: Buffer.from('b') })
  })

  it('names what is missing', () => {
    expect(parseFileWrite('x')).toEqual({ error: expect.stringContaining('object') })
    expect(parseFileWrite({})).toEqual({ error: expect.stringContaining('path') })
    expect(parseFileWrite({ path: '/workspace' })).toEqual({ error: expect.stringContaining('inside') })
    expect(parseFileWrite({ type: 'file_id', path: 'x' })).toEqual({ error: expect.stringContaining('file_id') })
    expect(parseFileWrite({ path: 'x' })).toEqual({ error: expect.stringContaining('data') })
  })
})
