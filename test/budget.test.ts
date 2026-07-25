import { describe, expect, it } from 'vitest'
import { BASE_OVERHEAD_TOKENS, estimateBaseTokens, estimateFileTokens, estimateTokens } from '../src/budget.js'
import { ConfigSchema } from '../src/config.js'
import { FINDINGS_TOOL, SYSTEM_INSTRUCTIONS, SYSTEM_PREAMBLE } from '../src/prompt.js'

const defaults = ConfigSchema.parse({})

describe('estimateTokens', () => {
  it('rounds up, so a short string never estimates as free', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('')).toBe(0)
  })

  it('over-estimates relative to the ~4 chars/token prose average', () => {
    // 350 characters would be ~88 tokens at 4 chars/token; we claim 100.
    expect(estimateTokens('x'.repeat(350))).toBe(100)
  })
})

describe('estimateFileTokens', () => {
  it('charges the per-file scaffolding on top of the patch', () => {
    const withoutOverhead = estimateTokens('@@ -1 +1 @@\n+a\n') + estimateTokens('src/a.ts')
    expect(estimateFileTokens('src/a.ts', '@@ -1 +1 @@\n+a\n')).toBeGreaterThan(withoutOverhead)
  })
})

describe('BASE_OVERHEAD_TOKENS', () => {
  /**
   * The budget estimate is only allowed to err high. If the constant drifts below
   * what the prompt actually costs, every run quietly overshoots `token_budget` —
   * the one thing the estimate exists to prevent. This test ties the constant to
   * the real prompt text, so editing the system prompt without revisiting the
   * constant fails here rather than on a user's runner.
   */
  it('covers the static prompt and the tool schema', () => {
    const staticPrompt = `${SYSTEM_PREAMBLE}\n\nRULES\n\n${SYSTEM_INSTRUCTIONS}`
    const toolSchema = JSON.stringify(FINDINGS_TOOL)
    const actual = estimateTokens(staticPrompt) + estimateTokens(toolSchema)

    expect(BASE_OVERHEAD_TOKENS).toBeGreaterThanOrEqual(actual)
  })

  it('is not wastefully high — within 25% of the real cost', () => {
    const staticPrompt = `${SYSTEM_PREAMBLE}\n\nRULES\n\n${SYSTEM_INSTRUCTIONS}`
    const actual = estimateTokens(staticPrompt) + estimateTokens(JSON.stringify(FINDINGS_TOOL))

    expect(BASE_OVERHEAD_TOKENS).toBeLessThan(actual * 1.25)
  })
})

describe('estimateBaseTokens', () => {
  it('adds the configured rules to the fixed overhead', () => {
    expect(estimateBaseTokens(defaults)).toBeGreaterThan(BASE_OVERHEAD_TOKENS)
  })

  it('grows when rules are added', () => {
    const richer = ConfigSchema.parse({
      rules: [
        ...defaults.rules,
        { id: 'extra', description: 'A very long extra rule description. '.repeat(20), severity: 'warn' }
      ]
    })
    expect(estimateBaseTokens(richer)).toBeGreaterThan(estimateBaseTokens(defaults))
  })
})
