/**
 * Unified-diff parsing, and the mapping from a file line to a commentable anchor.
 *
 * A review comment can only be attached to a line GitHub considers part of the
 * diff. The model, however, will happily cite any line number it likes. This
 * module is the arbiter: it parses the patch GitHub gave us, records exactly
 * which head-file lines are anchorable, and renders the same patch with a line
 * gutter so the model is citing numbers it can actually see.
 *
 * Both halves have to agree, which is why they live in one file: the numbers in
 * `renderAnnotatedPatch` are the keys of `commentable`.
 */

/** Which side of the diff an anchor refers to, in GitHub's review-comment vocabulary. */
export type DiffSide = 'LEFT' | 'RIGHT'

export type DiffLineKind = 'add' | 'del' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  /** 1-based line number in the head file. Null on a removed line. */
  newLine: number | null
  /** 1-based line number in the base file. Null on an added line. */
  oldLine: number | null
  /**
   * GitHub's legacy `position`: lines counted from just below the first `@@`
   * header, where later hunk headers each consume one. Retained because the
   * review-comment API still accepts it and it is useful in error reports.
   */
  position: number
  /** Line content with the leading +/-/space marker removed. */
  content: string
}

export interface Hunk {
  /** The raw `@@ ... @@` line, including any trailing section heading. */
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface ParsedPatch {
  hunks: Hunk[]
  /** Every content line of the diff, in order. */
  lines: DiffLine[]
  /**
   * Head-file line number → line, for every line a comment can anchor to.
   *
   * Includes unchanged context lines: they are part of the diff, and a finding
   * often needs to point at the line a change broke rather than the change.
   */
  commentable: Map<number, DiffLine>
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Parse the `patch` string from the GitHub files API.
 *
 * That string starts at the first `@@` — there is no `diff --git` preamble — but
 * lines before the first hunk header are ignored anyway so a full diff also parses.
 */
export function parsePatch(patch: string): ParsedPatch {
  const hunks: Hunk[] = []
  const lines: DiffLine[] = []
  const commentable = new Map<number, DiffLine>()

  // A trailing newline would otherwise split into a phantom empty context line,
  // which would invent a commentable line one past the end of the file.
  const body = patch.endsWith('\n') ? patch.slice(0, -1) : patch

  let hunk: Hunk | undefined
  let oldLine = 0
  let newLine = 0
  let position = 0

  for (const raw of body.split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      // Every hunk header after the first is itself a line of the diff and
      // advances `position`; the first one is where position counting starts.
      if (hunks.length > 0) position += 1
      oldLine = Number(header[1])
      newLine = Number(header[2])
      hunk = { header: raw, oldStart: oldLine, newStart: newLine, lines: [] }
      hunks.push(hunk)
      continue
    }

    if (!hunk) continue
    // "\ No newline at end of file" annotates the previous line; it is not one.
    if (raw.startsWith('\\')) continue

    position += 1
    // An empty string is a context line whose content is empty, not a malformed
    // line — git omits the trailing space on blank context lines in some diffs.
    const marker = raw.charAt(0)
    const content = raw.slice(1)

    let line: DiffLine
    if (marker === '+') {
      line = { kind: 'add', newLine, oldLine: null, position, content }
      newLine += 1
    } else if (marker === '-') {
      line = { kind: 'del', newLine: null, oldLine, position, content }
      oldLine += 1
    } else {
      line = { kind: 'context', newLine, oldLine, position, content }
      newLine += 1
      oldLine += 1
    }

    if (line.newLine !== null) commentable.set(line.newLine, line)
    hunk.lines.push(line)
    lines.push(line)
  }

  return { hunks, lines, commentable }
}

/** Width of the line-number gutter in the rendered patch. */
const GUTTER_WIDTH = 6

/**
 * Render the patch with a head-file line number against every anchorable line.
 *
 * This is what the model sees. Without it the model has to count lines from the
 * hunk header itself, which it does unreliably, and every off-by-one becomes a
 * dropped finding. The numbers here are exactly the keys of `commentable`.
 */
export function renderAnnotatedPatch(parsed: ParsedPatch): string {
  const out: string[] = []
  for (const hunk of parsed.hunks) {
    out.push(hunk.header)
    for (const line of hunk.lines) {
      const gutter = (line.newLine === null ? '' : String(line.newLine)).padStart(GUTTER_WIDTH)
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
      out.push(`${gutter} |${marker}${line.content}`)
    }
  }
  return out.join('\n')
}
