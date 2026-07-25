import { describe, expect, it } from 'vitest'
import { parsePatch, renderAnnotatedPatch } from '../src/patch.js'

/** Two hunks, an addition, a deletion, a replacement, and context around each. */
const MULTI_HUNK = [
  '@@ -1,4 +1,5 @@ function head()',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' return a',
  '@@ -20,3 +21,3 @@ function tail()',
  ' before',
  '-old tail',
  '+new tail'
].join('\n')

describe('parsePatch', () => {
  it('numbers added and context lines against the head file', () => {
    const parsed = parsePatch(MULTI_HUNK)

    expect([...parsed.commentable.keys()]).toEqual([1, 2, 3, 4, 21, 22])
  })

  it('numbers removed lines against the base file and leaves them unanchorable', () => {
    const parsed = parsePatch(MULTI_HUNK)
    const removed = parsed.lines.filter(line => line.kind === 'del')

    expect(removed.map(line => line.oldLine)).toEqual([2, 21])
    expect(removed.every(line => line.newLine === null)).toBe(true)
  })

  it('resumes numbering from the second hunk header rather than counting through the gap', () => {
    const parsed = parsePatch(MULTI_HUNK)

    expect(parsed.commentable.get(21)?.content).toBe('before')
    expect(parsed.commentable.get(22)?.content).toBe('new tail')
  })

  it('counts position from below the first header, with later headers taking one', () => {
    const parsed = parsePatch(MULTI_HUNK)

    // Lines 1..5 of hunk one are positions 1..5; the second @@ takes 6.
    expect(parsed.commentable.get(1)?.position).toBe(1)
    expect(parsed.commentable.get(4)?.position).toBe(5)
    expect(parsed.commentable.get(21)?.position).toBe(7)
  })

  it('keeps context lines commentable — a finding often points at what a change broke', () => {
    const parsed = parsePatch(MULTI_HUNK)

    expect(parsed.commentable.get(1)?.kind).toBe('context')
  })

  it('treats a bare empty line as an empty context line', () => {
    const parsed = parsePatch(['@@ -1,3 +1,3 @@', ' a', '', '+c'].join('\n'))

    expect(parsed.commentable.get(2)?.kind).toBe('context')
    expect(parsed.commentable.get(2)?.content).toBe('')
    expect(parsed.commentable.get(3)?.content).toBe('c')
  })

  it('does not invent a line past the end when the patch ends with a newline', () => {
    const withNewline = parsePatch('@@ -1,1 +1,2 @@\n a\n+b\n')
    const without = parsePatch('@@ -1,1 +1,2 @@\n a\n+b')

    expect([...withNewline.commentable.keys()]).toEqual([1, 2])
    expect([...withNewline.commentable.keys()]).toEqual([...without.commentable.keys()])
  })

  it('ignores the no-newline-at-end-of-file marker without consuming a line number', () => {
    const parsed = parsePatch(['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+c'].join('\n'))

    expect([...parsed.commentable.keys()]).toEqual([1, 2])
    expect(parsed.commentable.get(2)?.content).toBe('c')
  })

  it('handles a single-line hunk header with no count', () => {
    const parsed = parsePatch('@@ -5 +5 @@\n-old\n+new')

    expect([...parsed.commentable.keys()]).toEqual([5])
    expect(parsed.lines.find(line => line.kind === 'del')?.oldLine).toBe(5)
  })

  it('preserves the section heading on the hunk header', () => {
    expect(parsePatch(MULTI_HUNK).hunks[0]?.header).toBe('@@ -1,4 +1,5 @@ function head()')
  })

  it('returns nothing for a patch with no hunks', () => {
    const parsed = parsePatch('')

    expect(parsed.hunks).toEqual([])
    expect(parsed.commentable.size).toBe(0)
  })

  it('ignores a git preamble before the first hunk', () => {
    const parsed = parsePatch(
      ['diff --git a/x.ts b/x.ts', 'index 1234567..89abcde 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '+a'].join(
        '\n'
      )
    )

    expect([...parsed.commentable.keys()]).toEqual([1])
  })
})

describe('renderAnnotatedPatch', () => {
  it('puts the head-file line number in a gutter the model can cite', () => {
    const rendered = renderAnnotatedPatch(parsePatch('@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d'))

    expect(rendered.split('\n')).toEqual([
      '@@ -1,2 +1,3 @@',
      '     1 | a',
      '       |-b',
      '     2 |+c',
      '     3 |+d'
    ])
  })

  it('leaves the gutter blank exactly for the lines that cannot be commented on', () => {
    const parsed = parsePatch(MULTI_HUNK)
    const rendered = renderAnnotatedPatch(parsed)

    const blankGutter = rendered.split('\n').filter(line => line.startsWith('       |'))
    expect(blankGutter).toHaveLength(2) // the two removed lines
  })

  it('renders every number that parsePatch reports as commentable, and no others', () => {
    const parsed = parsePatch(MULTI_HUNK)
    const rendered = renderAnnotatedPatch(parsed)

    // The gutter is the model's only source of line numbers, so the two must
    // agree exactly or findings get dropped for citing what they were shown.
    const printed = rendered
      .split('\n')
      .map(line => /^\s*(\d+) \|/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)

    expect(printed).toEqual([...parsed.commentable.keys()])
  })
})
