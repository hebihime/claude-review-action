import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.js'
import type { MappedFinding, SelectionResult } from '../src/findings.js'
import { decideVerdict, verdictCandidates } from '../src/verdict.js'

function finding(severity: MappedFinding['severity'], line = 1): MappedFinding {
  return {
    path: 'src/a.ts',
    line,
    side: 'RIGHT',
    position: line,
    severity,
    modelSeverity: severity,
    ruleId: 'correctness',
    message: 'something',
    onContextLine: false,
    fingerprint: `fp-${severity}-${line}`
  }
}

function selection(selected: MappedFinding[], suppressed: SelectionResult['suppressed'] = []): SelectionResult {
  return { selected, suppressed }
}

const defaults = ConfigSchema.parse({})

describe('decideVerdict', () => {
  it('approves a clean review by default', () => {
    expect(decideVerdict(selection([]), defaults)).toBe('approve')
  })

  it('comments rather than approving when approve_when_clean is off', () => {
    const config = ConfigSchema.parse({ verdict: { approve_when_clean: false, request_changes_on: 'error' } })

    expect(decideVerdict(selection([]), config)).toBe('comment')
  })

  it('requests changes on an error finding', () => {
    expect(decideVerdict(selection([finding('error')]), defaults)).toBe('request_changes')
  })

  it('only comments when the worst finding is below request_changes_on', () => {
    expect(decideVerdict(selection([finding('warn')]), defaults)).toBe('comment')
  })

  it('honours a lowered request_changes_on threshold', () => {
    const config = ConfigSchema.parse({ verdict: { request_changes_on: 'warn', approve_when_clean: true } })

    expect(decideVerdict(selection([finding('warn')]), config)).toBe('request_changes')
  })

  it('still requests changes for an error that max_comments held back', () => {
    // The cap is a display limit, not absolution: the twenty-first error is
    // still an error, and the summary will list it.
    const capped = selection([finding('nit')], [{ finding: finding('error', 2), reason: 'over-max-comments' }])

    expect(decideVerdict(capped, defaults)).toBe('request_changes')
  })

  it('ignores findings dropped by min_severity_to_comment', () => {
    // The repository said this severity is not worth acting on; it should not
    // colour the verdict either.
    const filtered = selection([], [{ finding: finding('error', 2), reason: 'below-min-severity' }])

    expect(decideVerdict(filtered, defaults)).toBe('approve')
  })
})

describe('verdictCandidates', () => {
  it('includes selected findings and cap-suppressed ones, but not filtered ones', () => {
    const mixed = selection(
      [finding('warn', 1)],
      [
        { finding: finding('error', 2), reason: 'over-max-comments' },
        { finding: finding('nit', 3), reason: 'below-min-severity' }
      ]
    )

    expect(verdictCandidates(mixed).map(f => f.line)).toEqual([1, 2])
  })
})
