import { estimateBaseTokens, estimateFileTokens } from './budget.js'
import type { ReviewConfig } from './config.js'
import type { ChangedFile } from './diff.js'
import { isIgnored, resolveIgnorePatterns } from './filter.js'

export type SkipReason =
  /** Matched `ignore_paths` or a built-in ignore. */
  | 'ignored'
  /** The file was deleted; there is nothing left to comment on. */
  | 'deleted'
  /** Binary, or a diff GitHub declined to inline. */
  | 'no-patch'
  /** A rename or mode change with no content difference. */
  | 'no-changes'
  /** The file alone exceeds the whole token budget. */
  | 'too-large'
  /** Earlier files consumed the budget first. */
  | 'budget'

export interface SkippedFile {
  path: string
  reason: SkipReason
  /** One clause, ready to drop into the summary comment. */
  detail: string
}

export interface PlannedFile {
  file: ChangedFile
  patch: string
  estimatedTokens: number
}

export interface ReviewPlan {
  /** Files to review, highest churn first. */
  files: PlannedFile[]
  skipped: SkippedFile[]
  /** Base overhead plus every selected file. */
  estimatedTokens: number
  baseTokens: number
  tokenBudget: number
  /** True when at least one reviewable file was dropped to stay inside the budget. */
  budgetExhausted: boolean
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Highest churn first, ties broken by path.
 *
 * Churn ordering is the cost control the spec asks for: when the budget cannot
 * cover everything, the files that changed most get the tokens. The path
 * tie-break exists so two runs on the same commit produce the same plan — a
 * non-deterministic order would make idempotent comment updates flap.
 */
export function orderByChurn(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => b.churn - a.churn || a.path.localeCompare(b.path))
}

/**
 * Decide what this run will actually send to the model.
 *
 * Structural skips first (nothing to review), then ignore globs, then the token
 * budget. Every dropped file is recorded with a reason so the summary comment can
 * state plainly what was not looked at — a silent truncation would read as "clean".
 */
export function planReview(files: readonly ChangedFile[], config: ReviewConfig): ReviewPlan {
  const patterns = resolveIgnorePatterns(config)
  const skipped: SkippedFile[] = []
  const candidates: ChangedFile[] = []

  for (const file of files) {
    if (isIgnored(file.path, patterns)) {
      skipped.push({ path: file.path, reason: 'ignored', detail: 'matched an ignore pattern' })
      continue
    }
    if (file.status === 'removed') {
      skipped.push({ path: file.path, reason: 'deleted', detail: 'deleted in this pull request' })
      continue
    }
    if (file.patch === undefined) {
      skipped.push({
        path: file.path,
        reason: 'no-patch',
        detail: 'no text diff available (binary, or too large for the GitHub API to inline)'
      })
      continue
    }
    if (file.churn === 0 || file.patch.trim() === '') {
      skipped.push({ path: file.path, reason: 'no-changes', detail: 'no content change (rename or mode change only)' })
      continue
    }
    candidates.push(file)
  }

  const baseTokens = estimateBaseTokens(config)
  const budget = config.token_budget
  const planned: PlannedFile[] = []
  let used = baseTokens
  let budgetExhausted = false

  for (const file of orderByChurn(candidates)) {
    // Non-null: candidates only contains files with a patch.
    const patch = file.patch as string
    const tokens = estimateFileTokens(file.path, patch)

    if (baseTokens + tokens > budget) {
      skipped.push({
        path: file.path,
        reason: 'too-large',
        detail: `~${formatCount(tokens)} estimated tokens exceeds the entire ${formatCount(budget)}-token budget`
      })
      continue
    }
    if (used + tokens > budget) {
      // Keep walking rather than stopping: a small file after a large one still
      // fits, and reviewing it costs nothing extra. Every drop is still recorded.
      budgetExhausted = true
      skipped.push({
        path: file.path,
        reason: 'budget',
        detail: `~${formatCount(tokens)} estimated tokens, only ~${formatCount(budget - used)} of the ${formatCount(budget)}-token budget left`
      })
      continue
    }

    used += tokens
    planned.push({ file, patch, estimatedTokens: tokens })
  }

  return {
    files: planned,
    skipped,
    estimatedTokens: used,
    baseTokens,
    tokenBudget: budget,
    budgetExhausted
  }
}
