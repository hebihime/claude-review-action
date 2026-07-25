import { describe, expect, it } from 'vitest'
import { ConfigSchema, type ReviewConfig } from '../src/config.js'
import {
  countBySeverity,
  fingerprintOf,
  indexReviewed,
  MAX_MESSAGE_CHARS,
  selectFindings,
  validateFindings
} from '../src/findings.js'
import type { PlannedFile } from '../src/plan.js'

const PATCH = ['@@ -1,3 +1,5 @@', ' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4', ' return a'].join('\n')

function planned(path: string, patch = PATCH): PlannedFile {
  return {
    file: { path, status: 'modified', additions: 2, deletions: 1, churn: 3, patch },
    patch,
    estimatedTokens: 100
  }
}

const config = ConfigSchema.parse({})
const reviewed = indexReviewed([planned('src/a.ts')], config)

/** A finding on line 3 ("const b = 3"), which is an added line and always valid. */
function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'src/a.ts',
    line: 3,
    severity: 'error',
    rule_id: 'correctness',
    message: 'This inverts the condition.',
    ...overrides
  }
}

describe('validateFindings', () => {
  it('maps a valid finding onto a RIGHT-side anchor', () => {
    const { findings, dropped } = validateFindings({ findings: [finding()] }, reviewed)

    expect(dropped).toEqual([])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      path: 'src/a.ts',
      line: 3,
      side: 'RIGHT',
      ruleId: 'correctness',
      severity: 'error',
      onContextLine: false
    })
  })

  it('drops a finding on a line that is not in the diff, naming the line', () => {
    const { findings, dropped } = validateFindings({ findings: [finding({ line: 99 })] }, reviewed)

    expect(findings).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toBe('unmappable-line')
    expect(dropped[0]?.detail).toContain('src/a.ts:99')
  })

  it('drops a finding on a file that was never sent', () => {
    const { dropped } = validateFindings({ findings: [finding({ path: 'src/ghost.ts' })] }, reviewed)

    expect(dropped[0]?.reason).toBe('unknown-path')
  })

  it('drops a finding citing a rule that is not configured', () => {
    const { dropped } = validateFindings({ findings: [finding({ rule_id: 'invented-rule' })] }, reviewed)

    expect(dropped[0]?.reason).toBe('unknown-rule')
    expect(dropped[0]?.detail).toContain('invented-rule')
  })

  it('matches rule ids case-insensitively and normalises to the configured spelling', () => {
    const { findings } = validateFindings({ findings: [finding({ rule_id: 'CORRECTNESS' })] }, reviewed)

    expect(findings[0]?.ruleId).toBe('correctness')
  })

  it('keeps a finding anchored to an unchanged context line, and flags it as such', () => {
    const { findings } = validateFindings({ findings: [finding({ line: 1 })] }, reviewed)

    expect(findings[0]?.onContextLine).toBe(true)
  })

  it('uses the rule severity, not the model severity', () => {
    // "clarity" is a nit in the defaults; the model claiming error must not win.
    const { findings } = validateFindings(
      { findings: [finding({ rule_id: 'clarity', severity: 'error' })] },
      reviewed
    )

    expect(findings[0]?.severity).toBe('nit')
    expect(findings[0]?.modelSeverity).toBe('error')
  })

  it('drops a second finding with the same file, line and rule', () => {
    const { findings, dropped } = validateFindings({ findings: [finding(), finding()] }, reviewed)

    expect(findings).toHaveLength(1)
    expect(dropped[0]?.reason).toBe('duplicate')
  })

  it('keeps two findings on the same line under different rules', () => {
    const { findings } = validateFindings(
      { findings: [finding(), finding({ rule_id: 'security' })] },
      reviewed
    )

    expect(findings).toHaveLength(2)
  })

  it('drops only the malformed entry, keeping the rest of the review', () => {
    const { findings, dropped } = validateFindings(
      { findings: [{ path: 'src/a.ts' }, finding()] },
      reviewed
    )

    expect(findings).toHaveLength(1)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toBe('malformed')
  })

  it('strips unknown keys instead of rejecting the finding', () => {
    const { findings, dropped } = validateFindings(
      { findings: [finding({ confidence: 0.8 })] },
      reviewed
    )

    expect(dropped).toEqual([])
    expect(findings[0]).not.toHaveProperty('confidence')
  })

  it('truncates an overlong message rather than discarding a real finding', () => {
    const { findings } = validateFindings(
      { findings: [finding({ message: 'x'.repeat(MAX_MESSAGE_CHARS + 500) })] },
      reviewed
    )

    expect(findings[0]?.message).toHaveLength(MAX_MESSAGE_CHARS)
    expect(findings[0]?.message.endsWith('…')).toBe(true)
  })

  it('reports a tool call with no findings list as malformed', () => {
    const { dropped } = validateFindings({ nonsense: true }, reviewed)

    expect(dropped[0]?.reason).toBe('malformed')
  })

  it('accepts an empty findings list as a clean review', () => {
    expect(validateFindings({ findings: [] }, reviewed)).toEqual({ findings: [], dropped: [] })
  })

  it('carries a suggestion through when present', () => {
    const { findings } = validateFindings(
      { findings: [finding({ suggestion: 'const b = 2' })] },
      reviewed
    )

    expect(findings[0]?.suggestion).toBe('const b = 2')
  })

  it('fingerprints on path, line and rule so re-runs identify the same comment', () => {
    const { findings } = validateFindings({ findings: [finding()] }, reviewed)

    expect(findings[0]?.fingerprint).toBe(fingerprintOf('src/a.ts', 3, 'correctness'))
  })
})

describe('selectFindings', () => {
  const multi = indexReviewed([planned('src/a.ts'), planned('src/b.ts')], config)

  function manyFindings(count: number, ruleId = 'correctness'): Record<string, unknown>[] {
    // Lines 1..3 across two files gives six distinct anchors.
    const lines = [1, 3, 4]
    return Array.from({ length: count }, (_, index) => {
      const path = index < lines.length ? 'src/a.ts' : 'src/b.ts'
      return finding({ path, line: lines[index % lines.length], rule_id: ruleId })
    })
  }

  it('drops findings below min_severity_to_comment', () => {
    const strict: ReviewConfig = ConfigSchema.parse({ min_severity_to_comment: 'error' })
    const { findings } = validateFindings({ findings: [finding({ rule_id: 'clarity' })] }, reviewed)

    const { selected, suppressed } = selectFindings(findings, strict)

    expect(selected).toEqual([])
    expect(suppressed[0]?.reason).toBe('below-min-severity')
  })

  it('caps at max_comments and records what it held back', () => {
    const capped: ReviewConfig = ConfigSchema.parse({ max_comments: 2 })
    const { findings } = validateFindings({ findings: manyFindings(6) }, multi)

    const { selected, suppressed } = selectFindings(findings, capped)

    expect(selected).toHaveLength(2)
    expect(suppressed).toHaveLength(4)
    expect(suppressed.every(entry => entry.reason === 'over-max-comments')).toBe(true)
  })

  it('spends the cap on the most severe findings first', () => {
    const capped: ReviewConfig = ConfigSchema.parse({ max_comments: 1, min_severity_to_comment: 'nit' })
    const { findings } = validateFindings(
      {
        findings: [
          finding({ line: 1, rule_id: 'clarity' }), // nit
          finding({ line: 3, rule_id: 'correctness' }) // error
        ]
      },
      reviewed
    )

    const { selected } = selectFindings(findings, capped)

    expect(selected).toHaveLength(1)
    expect(selected[0]?.ruleId).toBe('correctness')
  })

  it('orders deterministically, so the same findings always survive the cap', () => {
    const capped: ReviewConfig = ConfigSchema.parse({ max_comments: 3 })
    const { findings } = validateFindings({ findings: manyFindings(6) }, multi)

    const first = selectFindings(findings, capped).selected.map(f => f.fingerprint)
    const second = selectFindings([...findings].reverse(), capped).selected.map(f => f.fingerprint)

    expect(second).toEqual(first)
  })
})

describe('countBySeverity', () => {
  it('counts each severity, including the zeroes', () => {
    const { findings } = validateFindings(
      { findings: [finding(), finding({ rule_id: 'clarity', line: 1 })] },
      reviewed
    )

    expect(countBySeverity(findings)).toEqual({ error: 1, warn: 0, nit: 1 })
  })
})
