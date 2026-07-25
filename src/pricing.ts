import type { ModelUsage } from './model.js'

/**
 * What a run cost, in dollars.
 *
 * Two rules govern this file. The first is that the numbers come from the API's
 * own reported usage, never from the 3.5-chars-per-token estimate the budget
 * walk uses — that estimate deliberately over-counts to decide what to send, and
 * reporting it as money would overstate every bill.
 *
 * The second is that an unknown model produces no number at all. A price table
 * is a snapshot of a published page, this action can be pinned at `v1` for a
 * year, and a repo can point `model:` at anything its gateway accepts. Printing
 * a confident dollar figure derived from a guessed rate would be worse than
 * printing the token counts and saying the rate is not known.
 */

/** When the table below was last checked against Anthropic's published pricing. */
export const PRICING_AS_OF = '2026-07'

export const PRICING_URL = 'https://www.anthropic.com/pricing#api'

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number
  /** USD per million output tokens. */
  outputPerMTok: number
}

/**
 * List prices only. Promotional rates are deliberately not encoded: they expire,
 * and a stale discount under-reports the bill, which is the wrong direction to
 * be wrong in. Models absent from this table are reported as unpriced.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 }
}

/** A cache hit bills at a tenth of the input rate. */
export const CACHE_READ_MULTIPLIER = 0.1

/** Writing a cache entry costs a quarter more than the plain input tokens. */
export const CACHE_WRITE_MULTIPLIER = 1.25

/** Longest first, so `claude-opus-4-6` cannot be matched by a shorter prefix. */
const KNOWN_IDS = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length)

/**
 * Find the price for a model id, tolerating the decorations vendors add.
 *
 * Bedrock and Vertex wrap the same model in their own identifiers
 * (`anthropic.claude-sonnet-5-v1:0`, `claude-sonnet-5@20260101`) and the
 * first-party API accepts dated aliases. All of them contain the canonical id,
 * so containment is enough and is far less brittle than a parser.
 */
export function priceFor(model: string): ModelPrice | null {
  const key = model.toLowerCase()
  const direct = MODEL_PRICES[key]
  if (direct) return direct

  for (const id of KNOWN_IDS) {
    if (key.includes(id)) return MODEL_PRICES[id] as ModelPrice
  }
  return null
}

export interface CostBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** Null when the model has no price on file — see the note at the top of this file. */
export function estimateCost(usage: ModelUsage, model: string): CostBreakdown | null {
  const price = priceFor(model)
  if (!price) return null

  const perInputToken = price.inputPerMTok / 1_000_000
  const perOutputToken = price.outputPerMTok / 1_000_000

  const input = usage.inputTokens * perInputToken
  const output = usage.outputTokens * perOutputToken
  const cacheRead = usage.cacheReadTokens * perInputToken * CACHE_READ_MULTIPLIER
  const cacheWrite = usage.cacheCreationTokens * perInputToken * CACHE_WRITE_MULTIPLIER

  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/**
 * Display form, including the dollar sign.
 *
 * A review of a small pull request on Haiku costs a fraction of a cent, so two
 * decimal places would render every honest run as `$0.00` and make the whole
 * readout look broken. Four places under a dollar, and an explicit `<$0.0001`
 * rather than a `$0.0000` that claims the run was free.
 */
export function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`
  if (amount > 0 && amount < 0.0001) return '<$0.0001'
  return `$${amount.toFixed(4)}`
}

/**
 * The `cost_usd` action output: a plain decimal another workflow step can
 * compare against a threshold, or the empty string when the cost is unknown.
 *
 * Unknown is not zero. A run whose model has no price on file spent real money,
 * and emitting `0.00` would let a spend guard pass on a run it could not price.
 */
export function costOutputValue(cost: CostBreakdown | null): string {
  return cost ? cost.total.toFixed(4) : ''
}
