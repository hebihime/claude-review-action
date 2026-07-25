import { describe, expect, it } from 'vitest'
import { parseConfig, type ReviewConfig } from '../src/config.js'
import {
  BASE_OVERHEAD_TOKENS,
  CHARS_PER_TOKEN,
  estimateBaseTokens,
  estimateFileTokens,
  estimateTokens,
  PER_FILE_OVERHEAD_TOKENS
} from '../src/budget.js'
import type { ChangedFile } from '../src/diff.js'
import { orderByChurn, planReview, type SkipReason } from '../src/plan.js'

function file(overrides: Partial<ChangedFile> & { path: string }): ChangedFile {
  const additions = overrides.additions ?? 10
  const deletions = overrides.deletions ?? 0
  return {
    status: 'modified',
    additions,
    deletions,
    churn: overrides.churn ?? additions + deletions,
    patch: '@@ -1,2 +1,2 @@\n-old\n+new\n',
    ...overrides
  }
}

/** A patch whose estimated token count is close to `tokens`. */
function patchOfTokens(tokens: number): string {
  return 'x'.repeat(Math.round((tokens - PER_FILE_OVERHEAD_TOKENS) * CHARS_PER_TOKEN))
}

function configWith(yaml = ''): ReviewConfig {
  return parseConfig(yaml)
}

function reasonFor(skipped: { path: string; reason: SkipReason }[], path: string): SkipReason | undefined {
  return skipped.find(entry => entry.path === path)?.reason
}

describe('token estimation', () => {
  it('estimates from character count and rounds up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('x'.repeat(350))).toBe(100)
    expect(estimateTokens('x')).toBe(1)
  })

  it('over-estimates rather than under-estimates, so the budget is not blown', () => {
    // ~4 chars/token is the usual prose rule of thumb; diffs tokenize worse, so
    // the estimate must come out above it.
    const text = 'x'.repeat(4000)

    expect(estimateTokens(text)).toBeGreaterThan(text.length / 4)
  })

  it('charges per-file overhead for the prompt scaffolding', () => {
    expect(estimateFileTokens('a.ts', '')).toBe(PER_FILE_OVERHEAD_TOKENS + estimateTokens('a.ts'))
  })

  it('charges the rules text against the base overhead', () => {
    const lean = configWith('rules:\n  - id: a\n    description: short\n    severity: warn\n')
    const verbose = configWith(
      `rules:\n  - id: a\n    description: "${'long '.repeat(200).trim()}"\n    severity: warn\n`
    )

    expect(estimateBaseTokens(lean)).toBeGreaterThanOrEqual(BASE_OVERHEAD_TOKENS)
    expect(estimateBaseTokens(verbose)).toBeGreaterThan(estimateBaseTokens(lean))
  })
})

describe('orderByChurn', () => {
  it('sorts by churn descending', () => {
    const ordered = orderByChurn([
      file({ path: 'small.ts', additions: 1 }),
      file({ path: 'big.ts', additions: 100 }),
      file({ path: 'medium.ts', additions: 50 })
    ])

    expect(ordered.map(f => f.path)).toEqual(['big.ts', 'medium.ts', 'small.ts'])
  })

  it('breaks ties by path so two runs on the same commit produce the same plan', () => {
    const files = [
      file({ path: 'c.ts', additions: 5 }),
      file({ path: 'a.ts', additions: 5 }),
      file({ path: 'b.ts', additions: 5 })
    ]

    expect(orderByChurn(files).map(f => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(orderByChurn([...files].reverse()).map(f => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('does not mutate its input', () => {
    const files = [file({ path: 'a.ts', additions: 1 }), file({ path: 'b.ts', additions: 9 })]

    orderByChurn(files)

    expect(files.map(f => f.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('planReview — structural skips', () => {
  it('skips files matching an ignore pattern', () => {
    const plan = planReview([file({ path: 'package-lock.json' }), file({ path: 'src/a.ts' })], configWith())

    expect(plan.files.map(f => f.file.path)).toEqual(['src/a.ts'])
    expect(reasonFor(plan.skipped, 'package-lock.json')).toBe('ignored')
  })

  it('skips deleted files, which have nothing to comment on', () => {
    const plan = planReview([file({ path: 'src/gone.ts', status: 'removed', deletions: 40 })], configWith())

    expect(plan.files).toHaveLength(0)
    expect(reasonFor(plan.skipped, 'src/gone.ts')).toBe('deleted')
  })

  it('skips files with no patch (binary, or too large for the API to inline)', () => {
    const plan = planReview([file({ path: 'logo.png', patch: undefined, additions: 0, churn: 0 })], configWith())

    expect(reasonFor(plan.skipped, 'logo.png')).toBe('no-patch')
  })

  it('skips a pure rename with no content change', () => {
    const plan = planReview(
      [file({ path: 'src/b.ts', previousPath: 'src/a.ts', status: 'renamed', additions: 0, deletions: 0, patch: '' })],
      configWith()
    )

    expect(reasonFor(plan.skipped, 'src/b.ts')).toBe('no-changes')
  })

  it('reports the ignore pattern as the reason even for a deleted lockfile', () => {
    const plan = planReview([file({ path: 'yarn.lock', status: 'removed' })], configWith())

    expect(reasonFor(plan.skipped, 'yarn.lock')).toBe('ignored')
  })

  it('records every skipped file exactly once', () => {
    const files = [
      file({ path: 'package-lock.json' }),
      file({ path: 'src/gone.ts', status: 'removed' }),
      file({ path: 'logo.png', patch: undefined }),
      file({ path: 'src/keep.ts' })
    ]

    const plan = planReview(files, configWith())

    expect(plan.skipped).toHaveLength(3)
    expect(new Set(plan.skipped.map(s => s.path)).size).toBe(3)
    expect(plan.files).toHaveLength(1)
  })
})

describe('planReview — token budget', () => {
  const budgetYaml = 'token_budget: 10000\nrules:\n  - id: a\n    description: short\n    severity: warn\n'

  it('reviews the highest-churn files first when the budget cannot cover everything', () => {
    const config = configWith(budgetYaml)
    const room = config.token_budget - estimateBaseTokens(config)
    const each = Math.floor(room / 2) - 100

    const plan = planReview(
      [
        file({ path: 'low.ts', additions: 1, patch: patchOfTokens(each) }),
        file({ path: 'high.ts', additions: 900, patch: patchOfTokens(each) }),
        file({ path: 'mid.ts', additions: 400, patch: patchOfTokens(each) })
      ],
      config
    )

    expect(plan.files.map(f => f.file.path)).toEqual(['high.ts', 'mid.ts'])
    expect(reasonFor(plan.skipped, 'low.ts')).toBe('budget')
    expect(plan.budgetExhausted).toBe(true)
  })

  it('stays within the budget', () => {
    const config = configWith(budgetYaml)

    const plan = planReview(
      Array.from({ length: 20 }, (_, index) =>
        file({ path: `src/f${index}.ts`, additions: index, patch: patchOfTokens(1500) })
      ),
      config
    )

    expect(plan.estimatedTokens).toBeLessThanOrEqual(config.token_budget)
    expect(plan.files.length).toBeGreaterThan(0)
    expect(plan.files.length).toBeLessThan(20)
  })

  it('keeps going after a file is dropped, so a small file still gets reviewed', () => {
    const config = configWith(budgetYaml)
    const room = config.token_budget - estimateBaseTokens(config)

    const plan = planReview(
      [
        file({ path: 'huge.ts', additions: 900, patch: patchOfTokens(room - 500) }),
        file({ path: 'big.ts', additions: 800, patch: patchOfTokens(room - 500) }),
        file({ path: 'tiny.ts', additions: 1, patch: patchOfTokens(300) })
      ],
      config
    )

    expect(plan.files.map(f => f.file.path)).toEqual(['huge.ts', 'tiny.ts'])
    expect(reasonFor(plan.skipped, 'big.ts')).toBe('budget')
  })

  it('separates "too large to ever fit" from "the budget ran out"', () => {
    const config = configWith(budgetYaml)

    const plan = planReview(
      [
        file({ path: 'monster.ts', additions: 9999, patch: patchOfTokens(config.token_budget * 2) }),
        file({ path: 'normal.ts', additions: 5, patch: patchOfTokens(500) })
      ],
      config
    )

    expect(reasonFor(plan.skipped, 'monster.ts')).toBe('too-large')
    expect(plan.files.map(f => f.file.path)).toEqual(['normal.ts'])
    // A file that could never fit is not evidence that the budget was exhausted.
    expect(plan.budgetExhausted).toBe(false)
  })

  it('explains the drop in terms a summary comment can print', () => {
    const config = configWith(budgetYaml)
    const room = config.token_budget - estimateBaseTokens(config)

    const plan = planReview(
      [
        file({ path: 'first.ts', additions: 900, patch: patchOfTokens(room - 200) }),
        file({ path: 'second.ts', additions: 5, patch: patchOfTokens(2000) })
      ],
      config
    )

    expect(plan.skipped[0]?.detail).toMatch(/estimated tokens.*budget left/)
  })

  it('counts the base overhead against the budget', () => {
    const config = configWith(budgetYaml)

    const plan = planReview([file({ path: 'a.ts', patch: patchOfTokens(400) })], configWith(budgetYaml))

    expect(plan.baseTokens).toBe(estimateBaseTokens(config))
    expect(plan.estimatedTokens).toBe(plan.baseTokens + (plan.files[0]?.estimatedTokens ?? 0))
  })

  it('reports an empty plan without claiming the budget was exhausted', () => {
    const plan = planReview([], configWith())

    expect(plan.files).toEqual([])
    expect(plan.skipped).toEqual([])
    expect(plan.budgetExhausted).toBe(false)
    expect(plan.estimatedTokens).toBe(plan.baseTokens)
  })
})
