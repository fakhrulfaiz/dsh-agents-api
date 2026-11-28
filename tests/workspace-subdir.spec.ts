import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceSubdir, shellQuote } from '../src/sandbox/workspace-subdir.ts'

describe('normalizeWorkspaceSubdir', () => {
  it.each([
    [undefined, undefined], [null, undefined], ['', undefined], ['  ', undefined], ['.', undefined], ['/', undefined], ['./', undefined],
    ['biology', 'biology'], [' ./biology/ ', 'biology'], ['a//b///c/', 'a/b/c'], ['a/./b', 'a/./b'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeWorkspaceSubdir(input)).toBe(expected)
  })

  it.each([
    ['/etc'], ['../x'], ['a/../b'], ['a\\b'], ['a\u0000b'], ['a\nb'], ['x'.repeat(201)], ['1/2/3/4/5/6/7/8/9'], [42],
  ])('refuses %j', (input) => {
    expect(normalizeWorkspaceSubdir(input)).toEqual({ error: expect.any(String) })
  })

  it('quotes for the shell', () => {
    expect(shellQuote("a b'c")).toBe(`'a b'\\''c'`)
  })
})
