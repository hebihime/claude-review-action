import * as core from '@actions/core'
import { readInputs } from './inputs.js'
import { hasSkipLabel, loadPullRequestContext, SKIP_REVIEW_LABEL } from './context.js'
import { callGitHub, createOctokit, type Octokit } from './github.js'
import { loadConfig, type ReviewConfig } from './config.js'
import { fetchChangedFiles, GITHUB_MAX_FILES } from './diff.js'
import { planReview, type ReviewPlan, type SkippedFile } from './plan.js'
import { assemblePrompt } from './prompt.js'
import { requestReview, type ReviewOutcome } from './model.js'
import {
  countBySeverity,
  indexReviewed,
  selectFindings,
  validateFindings,
  type DroppedFinding,
  type MappedFinding,
  type SelectionResult
} from './findings.js'
import { decideVerdict } from './verdict.js'
import { listReviewComments, planComments, syncComments, type SyncResult } from './comments.js'
import { renderSummary, summaryCostOutput, syncSummary, type SummaryInput } from './summary.js'

/** Group the skipped files by reason so the log stays short on a big PR. */
function logSkipped(skipped: readonly SkippedFile[]): void {
  const byReason = new Map<string, SkippedFile[]>()
  for (const file of skipped) {
    const bucket = byReason.get(file.reason)
    if (bucket) bucket.push(file)
    else byReason.set(file.reason, [file])
  }

  for (const [reason, files] of byReason) {
    core.startGroup(`Skipped (${reason}): ${files.length}`)
    for (const file of files) core.info(`${file.path} — ${file.detail}`)
    core.endGroup()
  }
}

function logPlan(plan: ReviewPlan): void {
  core.startGroup(`Reviewing ${plan.files.length} file(s), highest churn first`)
  for (const planned of plan.files) {
    const { file } = planned
    core.info(
      `${file.path} (+${file.additions} / -${file.deletions}) ~${planned.estimatedTokens.toLocaleString('en-US')} tokens`
    )
  }
  core.endGroup()

  logSkipped(plan.skipped)

  core.info(
    `Estimated prompt tokens: ~${plan.estimatedTokens.toLocaleString('en-US')} of ${plan.tokenBudget.toLocaleString('en-US')} (including ~${plan.baseTokens.toLocaleString('en-US')} of rules and instructions).`
  )
  if (plan.budgetExhausted) {
    core.warning(
      `The token budget was exhausted; ${plan.skipped.filter(f => f.reason === 'budget').length} file(s) were left unreviewed. Raise token_budget or narrow the pull request.`
    )
  }
}

/** Group the dropped findings by reason, so a systematic failure is visible at a glance. */
function logDropped(dropped: readonly DroppedFinding[]): void {
  if (dropped.length === 0) return

  const byReason = new Map<string, DroppedFinding[]>()
  for (const drop of dropped) {
    const bucket = byReason.get(drop.reason)
    if (bucket) bucket.push(drop)
    else byReason.set(drop.reason, [drop])
  }

  for (const [reason, drops] of byReason) {
    core.startGroup(`Findings dropped (${reason}): ${drops.length}`)
    for (const drop of drops) core.info(drop.detail)
    core.endGroup()
  }

  // Worth a warning rather than a quiet group: a model that cannot cite a valid
  // line is a prompt problem, and it would otherwise look like a clean review.
  const unmappable = dropped.filter(drop => drop.reason === 'unmappable-line').length
  if (unmappable > 0) {
    core.warning(
      `${unmappable} finding(s) cited a line that is not part of the diff and could not be anchored to a comment.`
    )
  }
}

function logFindings(selection: SelectionResult, findings: readonly MappedFinding[]): void {
  const counts = countBySeverity(selection.selected)
  core.info(
    `Findings: ${selection.selected.length} to report (${counts.error} error, ${counts.warn} warn, ${counts.nit} nit) out of ${findings.length} mapped.`
  )

  if (selection.selected.length > 0) {
    core.startGroup(`Findings (${selection.selected.length})`)
    for (const finding of selection.selected) {
      core.info(`${finding.severity.toUpperCase()} ${finding.path}:${finding.line} [${finding.ruleId}] ${finding.message}`)
    }
    core.endGroup()
  }

  const belowMin = selection.suppressed.filter(entry => entry.reason === 'below-min-severity').length
  if (belowMin > 0) {
    core.info(`${belowMin} finding(s) were below min_severity_to_comment and will not be posted.`)
  }
  const overCap = selection.suppressed.filter(entry => entry.reason === 'over-max-comments').length
  if (overCap > 0) {
    core.warning(
      `${overCap} finding(s) exceeded max_comments and will not be posted as inline comments. They still count towards the verdict.`
    )
  }

  // The rule's severity is authoritative; log the disagreements so a rule whose
  // severity is consistently wrong for its description is visible.
  const disagreements = selection.selected.filter(finding => finding.modelSeverity !== finding.severity).length
  if (disagreements > 0) {
    core.info(
      `${disagreements} finding(s) were re-labelled to their rule's configured severity (the model proposed a different one).`
    )
  }
}

/**
 * One line for the common case, detail only when something happened.
 *
 * A steady-state re-run should read `0 created, 0 updated, 3 unchanged` — that is
 * the whole promise of the idempotency marker, and it should be visible at a
 * glance in the log without opening a group.
 */
function logComments(result: SyncResult): void {
  core.info(
    `Comments:      ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.resolved} resolved, ${result.revived} revived.`
  )

  if (result.collapseNote) {
    core.info(
      `Resolved comments were marked in place but could not be collapsed: ${result.collapseNote}. The review itself is unaffected.`
    )
  }

  if (result.failures.length > 0) {
    core.warning(
      `${result.failures.length} comment(s) were rejected by GitHub and could not be posted. The rest of the review was posted normally.`
    )
    core.startGroup(`Rejected comments (${result.failures.length})`)
    for (const failure of result.failures) core.info(`${failure.path}:${failure.line ?? '?'} — ${failure.detail}`)
    core.endGroup()
  }
}

function logUsage(outcome: ReviewOutcome, config: ReviewConfig): void {
  if (outcome.note) core.info(outcome.note)

  if (outcome.truncated) {
    core.warning(
      "The model's reply hit the output token limit, so its findings list may be incomplete. Narrow the pull request, or lower token_budget so fewer files are reviewed at once."
    )
  }

  if (!outcome.usage) {
    core.info(`Model usage:   none — provider "${outcome.provider}" did not call the API.`)
    return
  }
  core.info(
    `Model usage:   ${outcome.usage.inputTokens.toLocaleString('en-US')} input / ${outcome.usage.outputTokens.toLocaleString('en-US')} output tokens on ${config.model}.`
  )
}

/**
 * The whole review, end to end.
 *
 * Resolves the PR, loads and validates the config, fetches the diff, decides
 * what fits the token budget, asks the model for findings, maps each one onto a
 * line a comment can actually anchor to, reconciles those findings against the
 * comments already on the pull request, and posts the one summary comment that
 * carries the verdict and what the run cost.
 */
export async function run(): Promise<void> {
  const inputs = readInputs()

  const pr = loadPullRequestContext()
  if (!pr) {
    core.notice(
      'Not a pull_request event — nothing to review. Trigger this action on pull_request (opened, synchronize, reopened).'
    )
    core.setOutput('skipped', 'true')
    return
  }

  if (hasSkipLabel(pr)) {
    core.notice(`PR #${pr.number} carries the "${SKIP_REVIEW_LABEL}" label — skipping review.`)
    core.setOutput('skipped', 'true')
    return
  }

  const { config, source } = loadConfig(inputs.configPath)
  const octokit = createOctokit(inputs.githubToken)

  const { data } = await callGitHub(`fetch pull request #${pr.number}`, () =>
    octokit.rest.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: pr.number })
  )

  core.info(`Repository:    ${pr.owner}/${pr.repo}`)
  core.info(`Pull request:  #${pr.number} — ${pr.title}`)
  core.info(`Base <- head:  ${pr.baseRef} <- ${pr.headSha.slice(0, 7)}`)
  core.info(`Changed files: ${data.changed_files} (+${data.additions} / -${data.deletions})`)
  core.info(
    `Config:        ${source ?? `${inputs.configPath} (not found — using built-in defaults)`}, ${config.rules.length} rule(s)`
  )
  core.info(`Model:         ${config.model} via provider "${config.provider}"`)
  core.info('')

  const files = await fetchChangedFiles(octokit, pr)
  if (files.length >= GITHUB_MAX_FILES) {
    core.warning(
      `This pull request touches at least ${GITHUB_MAX_FILES} files, which is the maximum the GitHub API will list. Files beyond that limit are invisible to this action and were not considered.`
    )
  }

  const plan = planReview(files, config)
  logPlan(plan)

  if (plan.files.length === 0) {
    core.notice('No reviewable files in this pull request — nothing was sent to the model.')
    // Still summarised, and deliberately so: "every file here was ignored" is a
    // result the author needs to see, and a silent success looks like a review
    // that found nothing wrong.
    await conclude(octokit, {
      pr,
      config,
      selection: emptySelection(),
      mappedCount: 0,
      dropped: [],
      plan,
      outcome: { provider: config.provider, toolInput: { findings: [] }, usage: null, truncated: false },
      comments: null
    })
    return
  }

  core.info('')
  const prompt = assemblePrompt(pr, config, plan.files)
  const outcome = await requestReview(prompt, config, inputs.anthropicApiKey)
  logUsage(outcome, config)

  const reviewed = indexReviewed(plan.files, config)
  const { findings, dropped } = validateFindings(outcome.toolInput, reviewed)
  logDropped(dropped)

  const selection = selectFindings(findings, config)
  logFindings(selection, findings)

  core.info('')
  // `dry-run` stopped before the model, so its empty findings list is "we did not
  // look", not "we looked and found nothing". Reconciling against it would resolve
  // every comment on the pull request and then recreate them on the next real run.
  let comments: SyncResult | null = null
  if (outcome.provider === 'dry-run') {
    core.info('Comments:      none — provider "dry-run" produced no findings to reconcile against.')
  } else {
    const existing = await listReviewComments(octokit, pr)
    const reviewedPaths = new Set(plan.files.map(planned => planned.file.path))
    const commentPlan = planComments(selection.selected, existing, reviewedPaths)
    comments = await syncComments(octokit, pr, commentPlan)
    logComments(comments)
  }

  await conclude(octokit, {
    pr,
    config,
    selection,
    mappedCount: findings.length,
    dropped,
    plan,
    outcome,
    comments
  })
}

function emptySelection(): SelectionResult {
  return { selected: [], suppressed: [] }
}

/** Everything the summary needs except the verdict, which `conclude` derives. */
type RunResult = Omit<SummaryInput, 'verdict'>

/**
 * Decide the verdict, publish the summary, and set the outputs.
 *
 * One function so the two exits from `run` — nothing reviewable, and a completed
 * review — cannot drift apart and report differently.
 */
async function conclude(octokit: Octokit, result: RunResult): Promise<void> {
  const summary: SummaryInput = { ...result, verdict: decideVerdict(result.selection, result.config) }
  await postSummary(octokit, summary)
  finish(summary)
}

async function postSummary(octokit: Octokit, summary: SummaryInput): Promise<void> {
  // Same rule as the inline comments: a provider that never looked at the code
  // must not overwrite the summary of a run that did.
  if (summary.outcome.provider === 'dry-run') {
    core.info('Summary:       none — provider "dry-run" writes nothing to the pull request.')
    return
  }

  const result = await syncSummary(octokit, summary.pr, renderSummary(summary))
  core.info(`Summary:       ${result.action} — ${result.url}`)

  if (result.superseded > 0) {
    core.warning(
      `${result.superseded} duplicate summary comment(s) were found and collapsed. Two workflow runs on this pull request most likely raced to post the first one.`
    )
  }
  if (result.collapseNote) {
    core.info(`The superseded summary comment could not be collapsed: ${result.collapseNote}.`)
  }
}

/**
 * Set the outputs and the exit code.
 *
 * The check fails only when the verdict is `request_changes` *and* the repo opted
 * in with `fail_on_request_changes`. A failing check is a merge blocker, and a
 * model is not reliable enough to hold that veto by default.
 */
function finish(summary: SummaryInput): void {
  const { verdict, config } = summary

  core.setOutput('skipped', 'false')
  core.setOutput('verdict', verdict)
  core.setOutput('findings_count', String(summary.selection.selected.length))
  // Empty when the model has no published price on file — see `costOutputValue`.
  core.setOutput('cost_usd', summaryCostOutput(summary))

  core.info(`Verdict:       ${verdict}`)

  if (verdict === 'request_changes' && config.fail_on_request_changes) {
    core.setFailed(
      'Review verdict is request_changes and fail_on_request_changes is enabled, so this check is failing.'
    )
  }
}
