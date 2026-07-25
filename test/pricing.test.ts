import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL } from '../src/config.js'
import type { ModelUsage } from '../src/model.js'
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  costOutputValue,
  estimateCost,
  formatUsd,
  MODEL_PRICES,
  priceFor
} from '../src/pricing.js'

function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...overrides }
}

describe('priceFor', () => {
  it('prices the action default model, so a zero-config run has a cost readout', () => {
    expect(priceFor(DEFAULT_MODEL)).toEqual({ inputPerMTok: 1, outputPerMTok: 5 })
  })

  it('sees through the decorations Bedrock, Vertex and dated aliases add', () => {
    const sonnet = MODEL_PRICES['claude-sonnet-5']
    expect(priceFor('anthropic.claude-sonnet-5-v1:0')).toEqual(sonnet)
    expect(priceFor('claude-sonnet-5@20260101')).toEqual(sonnet)
    expect(priceFor('CLAUDE-SONNET-5')).toEqual(sonnet)
  })

  it('returns null for a model it has never heard of rather than guessing', () => {
    // The whole point: this action can be pinned at v1 for a year, and a repo can
    // point `model:` at anything its gateway accepts.
    expect(priceFor('some-gateway/llm-v3')).toBeNull()
    expect(priceFor('claude-opus-9')).toBeNull()
  })
})

describe('estimateCost', () => {
  it('bills input and output at their own rates', () => {
    const cost = estimateCost(usage({ inputTokens: 1_000_000, outputTokens: 100_000 }), 'claude-haiku-4-5')

    expect(cost).not.toBeNull()
    expect(cost?.input).toBeCloseTo(1, 10)
    expect(cost?.output).toBeCloseTo(0.5, 10)
    expect(cost?.total).toBeCloseTo(1.5, 10)
  })

  it('discounts cache reads and surcharges cache writes against the input rate', () => {
    const cost = estimateCost(
      usage({ cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 }),
      'claude-sonnet-5'
    )

    expect(cost?.cacheRead).toBeCloseTo(3 * CACHE_READ_MULTIPLIER, 10)
    expect(cost?.cacheWrite).toBeCloseTo(3 * CACHE_WRITE_MULTIPLIER, 10)
  })

  it('gives no number at all for an unpriced model', () => {
    expect(estimateCost(usage({ inputTokens: 5_000 }), 'mystery-model')).toBeNull()
  })
})

describe('formatUsd', () => {
  it('keeps four decimals under a dollar, because a real review costs fractions of a cent', () => {
    // Two decimals would render every honest Haiku run as $0.00.
    expect(formatUsd(0.0045)).toBe('$0.0045')
    expect(formatUsd(0)).toBe('$0.0000')
  })

  it('never renders a nonzero cost as zero', () => {
    expect(formatUsd(0.00002)).toBe('<$0.0001')
  })

  it('drops to cents once the run costs real money', () => {
    expect(formatUsd(12.3456)).toBe('$12.35')
  })
})

describe('costOutputValue', () => {
  it('is a plain decimal another workflow step can compare against a threshold', () => {
    expect(costOutputValue(estimateCost(usage({ inputTokens: 1_000_000 }), 'claude-haiku-4-5'))).toBe('1.0000')
  })

  it('is empty rather than zero when the cost is unknown', () => {
    // A spend guard must not pass a run just because it could not be priced.
    expect(costOutputValue(null)).toBe('')
  })
})
