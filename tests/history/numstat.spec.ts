import { describe, expect, it } from 'vitest'
import { parseNumstat, parseUnifiedDiff } from '../../src/history/numstat.ts'

describe('parseNumstat', () => {
  it('reads -z records, binary files and paths with spaces', () => {
    expect(parseNumstat('3\t1\tsrc/a b.ts\0-\t-\tbin.png\0\n0\t5\tgone.txt\0')).toEqual([
      { path: 'src/a b.ts', added: 3, deleted: 1 },
      { path: 'bin.png', added: 0, deleted: 0, binary: true },
      { path: 'gone.txt', added: 0, deleted: 5 },
    ])
  })
})

describe('parseUnifiedDiff', () => {
  it('reads two hunks and drops the no-newline marker', () => {
    const text = [
      'diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x',
      '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c',
      '@@ -10 +10,2 @@', '-old', '\\ No newline at end of file', '+new', '+more', '',
    ].join('\n')
    expect(parseUnifiedDiff(text)).toEqual({
      binary: false, before: true, after: true,
      hunks: [
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
        { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: ['-old', '+new', '+more'] },
      ],
    })
  })
  it('sees new, deleted and binary files', () => {
    expect(parseUnifiedDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+hi\n')).toMatchObject({ before: false, after: true })
    expect(parseUnifiedDiff('diff --git a/n b/n\ndeleted file mode 100644\n')).toMatchObject({ before: true, after: false })
    expect(parseUnifiedDiff('diff --git a/p b/p\nBinary files a/p and b/p differ\n').binary).toBe(true)
  })
})
