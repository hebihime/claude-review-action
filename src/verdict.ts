import { severityRank, type ReviewConfig } from './config.js'
import type { MappedFinding, SelectionResult } from './findings.js'

export type Verdict = 'approve' | 'comment' | 'request_changes'

/**
 * Which findings are allowed to drive the verdict.
 *
 * Everything that cleared `min_severity_to_comment`, including findings the
 * `max_comments` cap held back. The two limits mean different things:
 * `min_severity_to_comment` is the repository saying a severity is not worth
 * acting on, so it should not colour the verdict either; `max_comments` only
 * keeps a large pull request readable, and forgiving a real error because it was
 * the twenty-first one found would be the wrong reading of a display cap.
 */
export function verdictCandidates(selection: SelectionResult): MappedFinding[] {
  const capped = selection.suppressed
    .filter(entry => entry.reason === 'over-max-comments')
    .map(entry => entry.finding)
  return [...selection.selected, ...capped]
}

/**
 * Derive the run's verdict from the findings and the repository's config.
 *
 * Note this is the verdict *reported in the summary comment*, not a formal
 * GitHub review event — the action comments rather than submitting an approval,
 * because a bot approval can satisfy a required-review rule and let a human
 * review be skipped entirely.
 */
export function decideVerdict(selection: SelectionResult, config: ReviewConfig): Verdict {
  const candidates = verdictCandidates(selection)
  if (candidates.length === 0) {
    return config.verdict.approve_when_clean ? 'approve' : 'comment'
  }

  const threshold = severityRank(config.verdict.request_changes_on)
  const triggered = candidates.some(finding => severityRank(finding.severity) >= threshold)
  return triggered ? 'request_changes' : 'comment'
}
