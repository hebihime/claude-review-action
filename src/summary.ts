import { SEVERITIES, type ReviewConfig, type Severity } from './config.js'
import { isResolved, RESOLVED_MARKER, SEVERITY_LABEL, setCollapsed, type SyncResult } from './comments.js'
import type { PullRequestContext } from './context.js'
import type { DroppedFinding, SelectionResult } from './findings.js'
import { callGitHub, type Octokit } from './github.js'
import type { ReviewOutcome } from './model.js'
import type { ReviewPlan, SkipReason, SkippedFile } from './plan.js'
import { costOutputValue, estimateCost, formatUsd, PRICING_AS_OF, PRICING_URL } from './pricing.js'
import type { Verdict } from './verdict.js'

/**
 * The one comment that describes the run rather than a finding.
 *
 * It is an *issue* comment, not a review comment: it is about the pull request as
 * a whole, it has no line to anchor to, and it belongs in the conversation
 * timeline where the author will actually see it.
 *
 * Its idempotency rule is the mirror image of the inline comments'. There, the
 * body had to be a pure function of the finding so that a re-run rewrites nothing.
 * Here the body deliberately carries what changed about the *run* — token counts,
 * cost, the link to this workflow run — so a re-run is expected to rewrite it.
 * What must never happen is a second summary appearing, which is what the fixed
 * marker prevents.
 */

/** Fixed, not a fingerprint: there is exactly one summary per pull request. */
export const SUMMARY_MARKER = '<!-- claude-review:v1:summary -->'

const VERDICT_HEADING: Record<Verdict, string> = {
  approve: '✅ Claude review: APPROVE',
  comment: '💬 Claude review: COMMENT',
  request_changes: '🛑 Claude review: REQUEST CHANGES'
}

const SKIP_HEADING: Record<SkipReason, string> = {
  ignored: 'Ignored by pattern',
  deleted: 'Deleted in this pull request',
  'no-patch': 'No text diff available',
  'no-changes': 'No content change',
  'too-large': 'Larger than the entire token budget',
  budget: 'Token budget exhausted'
}

/** Most severe first — the reading order of a review summary. */
const DISPLAY_SEVERITIES: readonly Severity[] = [...SEVERITIES].reverse()

function count(value: number): string {
  return value.toLocaleString('en-US')
}

export interface SummaryInput {
  pr: PullRequestContext
  config: ReviewConfig
  verdict: Verdict
  selection: SelectionResult
  /** Findings that mapped to a real diff line, before filtering. */
  mappedCount: number
  dropped: readonly DroppedFinding[]
  plan: ReviewPlan
  outcome: ReviewOutcome
  /** Null when no inline comments were reconciled (nothing was reviewed). */
  comments: SyncResult | null
}

function renderFindingsTable(selection: SelectionResult): string {
  const selected = new Map<Severity, number>()
  const suppressed = new Map<Severity, number>()
  for (const finding of selection.selected) selected.set(finding.severity, (selected.get(finding.severity) ?? 0) + 1)
  for (const entry of selection.suppressed) {
    suppressed.set(entry.finding.severity, (suppressed.get(entry.finding.severity) ?? 0) + 1)
  }

  const rows = DISPLAY_SEVERITIES.map(
    severity => `| ${SEVERITY_LABEL[severity]} | ${selected.get(severity) ?? 0} | ${suppressed.get(severity) ?? 0} |`
  )
  return ['| Severity | Commented | Not commented |', '|:--|--:|--:|', ...rows].join('\n')
}

/**
 * The sentences under the table, and the reason this section exists at all.
 *
 * A count on its own reads as "nothing else was found". Each of these says what
 * was held back and which config key held it back, so the number in the
 * right-hand column is never a mystery.
 */
function renderFindingNotes(input: SummaryInput): string[] {
  const notes: string[] = []
  const { selection, config, dropped, outcome } = input

  const belowMin = selection.suppressed.filter(entry => entry.reason === 'below-min-severity').length
  if (belowMin > 0) {
    notes.push(
      `${count(belowMin)} finding(s) were below \`min_severity_to_comment: ${config.min_severity_to_comment}\` and were not commented on. They do not affect the verdict.`
    )
  }

  const overCap = selection.suppressed.filter(entry => entry.reason === 'over-max-comments').length
  if (overCap > 0) {
    notes.push(
      `${count(overCap)} finding(s) exceeded \`max_comments: ${config.max_comments}\` and were not commented on. They **do** count towards the verdict — the cap keeps the pull request readable, it does not forgive a finding.`
    )
  }

  const unmappable = dropped.filter(drop => drop.reason === 'unmappable-line').length
  if (unmappable > 0) {
    notes.push(
      `${count(unmappable)} finding(s) cited a line that is not part of the diff and could not be anchored to a comment. They were discarded.`
    )
  }

  if (outcome.truncated) {
    notes.push(
      '⚠️ The model\'s reply hit its output limit, so this list may be incomplete. Narrow the pull request, or lower `token_budget` so fewer files are reviewed at once.'
    )
  }

  return notes
}

function renderSkipped(skipped: readonly SkippedFile[]): string[] {
  if (skipped.length === 0) return []

  const byReason = new Map<SkipReason, SkippedFile[]>()
  for (const file of skipped) {
    const bucket = byReason.get(file.reason)
    if (bucket) bucket.push(file)
    else byReason.set(file.reason, [file])
  }

  // Collapsed by default: on a large pull request this list is longer than
  // everything else in the comment, and it is reference material, not the point.
  const lines = [`<details><summary><b>${count(skipped.length)} file(s) were not reviewed</b></summary>`, '']
  for (const [reason, files] of byReason) {
    lines.push(`**${SKIP_HEADING[reason]}** (${count(files.length)})`, '')
    for (const file of files) lines.push(`- \`${file.path}\` — ${file.detail}`)
    lines.push('')
  }
  lines.push('</details>')
  return lines
}

function renderUsageRows(input: SummaryInput): string[] {
  const { outcome, config, plan } = input
  const rows = [`| Model | \`${config.model}\` via provider \`${config.provider}\` |`]

  if (!outcome.usage) {
    // No API call means nothing was spent, which is a different statement from
    // "we could not work out what it cost" — and both are different from $0.00
    // appearing with no explanation.
    rows.push(
      `| Tokens | not measured — provider \`${config.provider}\` did not call the API |`,
      '| Estimated cost | **$0.00** — no model call was made |',
      renderBudgetRow(plan)
    )
    return rows
  }

  const usage = outcome.usage
  const cache =
    usage.cacheReadTokens + usage.cacheCreationTokens > 0
      ? ` (${count(usage.cacheReadTokens)} cache read, ${count(usage.cacheCreationTokens)} cache write)`
      : ''
  rows.push(`| Tokens | ${count(usage.inputTokens)} input · ${count(usage.outputTokens)} output${cache} |`)

  const cost = estimateCost(usage, config.model)
  rows.push(
    cost
      ? `| Estimated cost | **${formatUsd(cost.total)}** at [list prices](${PRICING_URL}) as of ${PRICING_AS_OF} |`
      : `| Estimated cost | unknown — no published price on file for \`${config.model}\`. The token counts above are exact; see [pricing](${PRICING_URL}). |`
  )
  rows.push(renderBudgetRow(plan))
  return rows
}

function renderBudgetRow(plan: ReviewPlan): string {
  return `| Prompt budget | ~${count(plan.estimatedTokens)} of ${count(plan.tokenBudget)} estimated tokens${plan.budgetExhausted ? ' — **exhausted**' : ''} |`
}

function renderCommentsRow(comments: SyncResult | null): string {
  if (!comments) return '| Inline comments | none — nothing was reviewed |'
  return `| Inline comments | ${comments.created} created, ${comments.updated} updated, ${comments.unchanged} unchanged, ${comments.resolved} resolved, ${comments.revived} revived |`
}

function headline(input: SummaryInput): string {
  const { selection, plan, verdict } = input
  if (plan.files.length === 0) {
    return 'No reviewable files in this pull request — nothing was sent to the model.'
  }
  if (selection.selected.length === 0 && selection.suppressed.length === 0) {
    return `Reviewed ${count(plan.files.length)} file(s) and found nothing to report.`
  }

  const reviewed = `Reviewed ${count(plan.files.length)} file(s)`
  const found = `${count(input.mappedCount)} finding(s)`
  const commented = `${count(selection.selected.length)} commented inline`
  const suffix = verdict === 'request_changes' ? ' Changes are requested.' : ''
  return `${reviewed}: ${found}, ${commented}.${suffix}`
}

/**
 * The whole summary comment body.
 *
 * Pure, so a test can assert the rendered markdown without a network stub, and so
 * `syncSummary` can compare it against what is already posted.
 */
export function renderSummary(input: SummaryInput): string {
  const { pr, plan, verdict } = input
  const parts = [SUMMARY_MARKER, `## ${VERDICT_HEADING[verdict]}`, '', headline(input), '']

  if (plan.files.length > 0) {
    parts.push('### Findings', '', renderFindingsTable(input.selection), '')
    const notes = renderFindingNotes(input)
    if (notes.length > 0) parts.push(...notes.map(note => `- ${note}`), '')
  }

  const skipped = renderSkipped(plan.skipped)
  if (skipped.length > 0) parts.push(...skipped, '')

  parts.push(
    '### This run',
    '',
    '| | |',
    '|:--|:--|',
    ...renderUsageRows(input),
    renderCommentsRow(input.comments),
    `| Workflow run | [logs](${pr.runUrl}) for \`${pr.headSha.slice(0, 7)}\` |`,
    ''
  )

  parts.push(
    '<sub>Posted as a comment, not as a formal review: an approval from a bot can satisfy a required-review rule and let a human review be skipped entirely. Costs are estimates from the API\'s reported token usage.</sub>'
  )

  return parts.join('\n')
}

/** Convenience for `run.ts`, so the output and the comment can never disagree. */
export function summaryCostOutput(input: SummaryInput): string {
  if (!input.outcome.usage) return '0.00'
  return costOutputValue(estimateCost(input.outcome.usage, input.config.model))
}

const SUPERSEDED_NOTE =
  '**Superseded** — a newer Claude review summary on this pull request replaces this one.'

export interface SummaryResult {
  action: 'created' | 'updated' | 'unchanged'
  /** Link to the comment, for the log. */
  url: string
  /** Duplicate summaries collapsed by this run; normally zero. */
  superseded: number
  collapseNote?: string
}

interface ExistingSummary {
  id: number
  nodeId: string
  body: string
  url: string
}

async function listSummaries(octokit: Octokit, pr: PullRequestContext): Promise<ExistingSummary[]> {
  const raw = await callGitHub(`list comments on pull request #${pr.number}`, () =>
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      per_page: 100
    })
  )

  return raw
    .filter(comment => (comment.body ?? '').includes(SUMMARY_MARKER))
    .map(comment => ({ id: comment.id, nodeId: comment.node_id, body: comment.body ?? '', url: comment.html_url }))
    .sort((a, b) => a.id - b.id)
}

/**
 * Post or update the single summary comment.
 *
 * Two pushes in quick succession start two workflow runs, and both can list the
 * comments before either has created one — so a pull request really can end up
 * with two summaries. The oldest live one wins every time (never the newest, or
 * the winner would change on every race) and the extras are folded away rather
 * than deleted, because a summary comment can already have replies under it.
 *
 * Unlike the inline comments, no failure here is tolerated. A summary that could
 * not be posted is the readout missing entirely, and a 403 that silently produced
 * a green check would be exactly the kind of quiet failure this action is meant
 * not to have.
 */
export async function syncSummary(octokit: Octokit, pr: PullRequestContext, body: string): Promise<SummaryResult> {
  const existing = await listSummaries(octokit, pr)
  const target = existing.find(comment => !isResolved(comment.body))
  let collapseNote: string | null = null
  let superseded = 0

  for (const comment of existing) {
    if (comment === target || isResolved(comment.body)) continue
    await callGitHub(`mark the duplicate summary comment ${comment.id} as superseded`, () =>
      octokit.rest.issues.updateComment({
        owner: pr.owner,
        repo: pr.repo,
        comment_id: comment.id,
        body: [SUMMARY_MARKER, RESOLVED_MARKER, SUPERSEDED_NOTE].join('\n')
      })
    )
    superseded += 1
    collapseNote ??= await setCollapsed(octokit, comment.nodeId, 'OUTDATED')
  }

  const result: SummaryResult = { action: 'created', url: '', superseded }

  if (!target) {
    const created = await callGitHub(`post the review summary on pull request #${pr.number}`, () =>
      octokit.rest.issues.createComment({ owner: pr.owner, repo: pr.repo, issue_number: pr.number, body })
    )
    result.url = created.data.html_url
  } else if (target.body.replace(/\r\n/g, '\n').trim() === body.trim()) {
    // Rare — the body carries the run link, so this only happens when the same
    // run posts twice — but skipping the write keeps `updated_at` honest.
    result.action = 'unchanged'
    result.url = target.url
  } else {
    const updated = await callGitHub(`update the review summary on pull request #${pr.number}`, () =>
      octokit.rest.issues.updateComment({ owner: pr.owner, repo: pr.repo, comment_id: target.id, body })
    )
    result.action = 'updated'
    result.url = updated.data.html_url
  }

  if (collapseNote) result.collapseNote = collapseNote
  return result
}
