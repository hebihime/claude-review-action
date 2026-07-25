import type { ReviewConfig } from './config.js'

/**
 * Token estimation, deliberately without a tokenizer.
 *
 * Shipping a tokenizer would add megabytes to the bundle, and asking the API to
 * count tokens costs a network round trip per run — for a *pre-flight* budget
 * check, neither is worth it. The estimate only has to be reliable enough to
 * stop a run from blowing past the budget, so it is tuned to over-estimate:
 * 3.5 characters per token rather than the ~4 that prose averages, because diffs
 * are dense in punctuation and indentation, which tokenize worse than words.
 *
 * The cost readout in the summary comment uses the API's reported usage, not
 * this estimate. This number is only ever used to decide what to send.
 */
export const CHARS_PER_TOKEN = 3.5

/** Per-file prompt scaffolding: the path header, framing, and response overhead. */
export const PER_FILE_OVERHEAD_TOKENS = 220

/** One-time cost of the system prompt and the findings tool schema. */
export const BASE_OVERHEAD_TOKENS = 900

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function estimateFileTokens(filePath: string, patch: string): number {
  return estimateTokens(patch) + estimateTokens(filePath) + PER_FILE_OVERHEAD_TOKENS
}

/** Tokens spent before any file is attached: system prompt, tool schema, rules. */
export function estimateBaseTokens(config: ReviewConfig): number {
  const rulesText = config.rules.map(rule => `${rule.id} ${rule.severity} ${rule.description}`).join('\n')
  return BASE_OVERHEAD_TOKENS + estimateTokens(rulesText)
}
